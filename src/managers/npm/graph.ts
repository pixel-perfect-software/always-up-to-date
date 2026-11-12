import { type LockedEntry, readLockfile } from '@/managers/npm/lockfile'
import { graphBuilder } from '@/utils/graphBuilder'
import type { InstalledGraph } from '@/utils/installedGraph'
import { isRecord } from '@/utils/isRecord'

/** The key of the copy a nested one sits in: `a/node_modules/b` → `a`, `node_modules/b` → `''`. */
const PARENT = /^(?:(.*)\/)?node_modules\/(?:@[^/]+\/)?[^/]+$/

const parentOf = (key: string): string | undefined => {
  const match = PARENT.exec(key)
  return match ? (match[1] ?? '') : undefined
}

type DependencyField =
  | 'dependencies'
  | 'devDependencies'
  | 'optionalDependencies'
  | 'peerDependencies'

/** The names an entry declares under `fields`. */
const declared = (
  entry: LockedEntry,
  fields: readonly DependencyField[],
): string[] =>
  fields.flatMap((field) => {
    const block = entry[field]
    return isRecord(block) ? Object.keys(block) : []
  })

/**
 * The installed graph from package-lock.json (lockfileVersion 2 and 3): the
 * same `name@version` ids as pnpm's, with no node_modules needed. `''` is the
 * root workspace, a key with no `node_modules/` is another workspace, and a
 * `node_modules/` key is an installed copy (a `link: true` one is a
 * workspace, never a node). npm installs peers, so a package's resolved peers
 * are edges, and so are a workspace's own peers. Undefined without a readable
 * lockfile.
 */
export const readNpmGraph = (cwd: string): InstalledGraph | undefined => {
  const lock = readLockfile(cwd)
  if (!lock) return undefined
  const entries = new Map(
    Object.entries(lock).filter((pair): pair is [string, LockedEntry] =>
      isRecord(pair[1]),
    ),
  )

  /** The id of an installed copy: undefined for a workspace link or a key that isn't one. */
  const idOf = (key: string): string | undefined => {
    const entry = entries.get(key)
    if (!entry || entry.link === true || typeof entry.version !== 'string') {
      return undefined
    }
    const at = key.lastIndexOf('node_modules/')
    if (at === -1) return undefined
    const name =
      typeof entry.name === 'string'
        ? entry.name
        : key.slice(at + 'node_modules/'.length)
    return `${name}@${entry.version}`
  }

  /**
   * The copy `name` resolves to from the entry at `from` (a workspace's
   * folder, `''` the root, or an installed copy's key): the nearest
   * `node_modules` up the tree that has it, then the root's.
   */
  const resolve = (from: string, name: string): string | undefined => {
    for (let at: string | undefined = from; at !== undefined; ) {
      const key =
        at === '' ? `node_modules/${name}` : `${at}/node_modules/${name}`
      if (entries.has(key)) return idOf(key)
      at = parentOf(at)
    }
    return idOf(`node_modules/${name}`)
  }

  const builder = graphBuilder()
  for (const [key, entry] of entries) {
    if (!key.includes('node_modules/')) {
      // A workspace folder: its direct dependencies, peers included.
      const importer = builder.importer(key === '' ? '.' : key)
      for (const name of declared(entry, [
        'dependencies',
        'devDependencies',
        'optionalDependencies',
        'peerDependencies',
      ])) {
        const id = resolve(key, name)
        if (id) importer.set(name, id)
      }
      continue
    }
    const id = idOf(key)
    if (!id) continue
    builder.node(id)
    for (const name of declared(entry, [
      'dependencies',
      'optionalDependencies',
      'peerDependencies',
    ])) {
      const target = resolve(key, name)
      if (target) builder.edge(id, name, target)
    }
  }
  return builder.graph()
}
