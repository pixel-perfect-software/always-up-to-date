import fs from 'fs'
import path from 'path'

/**
 * What is installed and what installed it, by `name@version` id (peer
 * suffixes dropped, so every variant of a version is one node). The peer
 * pass reads it to tell an installed package the run replaces from one that
 * stays.
 */
export interface InstalledGraph {
  /** Each workspace's direct dependencies, name → id, by its path from the root (`.` the root). */
  importers: Map<string, Map<string, string>>
  /**
   * Every installed id, with what it depends on as the manager resolved it:
   * its dependencies, optional dependencies and peers, each `{ name, id }`.
   */
  dependencies: Map<string, { name: string; id: string }[]>
}

const unquote = (text: string): string =>
  text.length > 1 && text.startsWith("'") && text.endsWith("'")
    ? text.slice(1, -1).replaceAll("''", "'")
    : text

/** `3.33.0(@tiptap/pm@3.33.0)` → `3.33.0`; pnpm puts the resolved peers in parentheses. */
const withoutPeers = (text: string): string => {
  const open = text.indexOf('(')
  return open === -1 ? text : text.slice(0, open)
}

// An alias resolves to `<target>@<version>`; a URL's `user@host` has a `:` first.
const ALIAS = /^(?:@[^/@]+\/)?[^/@:]+@./

/**
 * The id a dependency `name: version` resolves to, or undefined for a
 * workspace link or a local path, which aren't packages pnpm installs.
 */
const idOf = (name: string, value: string): string | undefined => {
  const version = withoutPeers(unquote(value.trim()))
  if (!version || /^(?:link|file):/.test(version)) return undefined
  return ALIAS.test(version) ? version : `${name}@${version}`
}

/** `name: value` at an indent, quotes removed; undefined for any other line. */
const entryAt = (
  line: string,
  indent: number,
): { key: string; value: string } | undefined => {
  if (line.length <= indent || line[indent] === ' ') return undefined
  if (line.slice(0, indent).trim() !== '') return undefined
  const text = line.slice(indent)
  // A plain key ends at the first `: ` or a `:` closing the line (a version
  // such as `link:../a` keeps its colon); a quoted one at its closing quote.
  const plain = text.indexOf(': ')
  const end = text.startsWith("'")
    ? text.indexOf("':", 1) + 1
    : plain === -1
      ? text.endsWith(':')
        ? text.length - 1
        : -1
      : plain
  if (end <= 0) return undefined
  return {
    key: unquote(text.slice(0, end)),
    value: text.slice(end + 1).trim(),
  }
}

const DEPENDENCY_SECTIONS = new Set([
  'dependencies',
  'devDependencies',
  'optionalDependencies',
])

/**
 * pnpm's record of the install, `node_modules/.pnpm/lock.yaml` (the lockfile
 * format, written by every install): `importers` for each workspace's direct
 * dependencies, `snapshots` for what each package was installed with. Read a
 * line at a time, as `readInstalledPeers` reads its keys. Undefined without
 * the file (another manager, or nothing installed).
 */
export const readInstalledGraph = (cwd: string): InstalledGraph | undefined => {
  let text: string
  try {
    text = fs.readFileSync(
      path.join(cwd, 'node_modules', '.pnpm', 'lock.yaml'),
      'utf8',
    )
  } catch {
    return undefined
  }
  const importers = new Map<string, Map<string, string>>()
  const dependencies = new Map<string, { name: string; id: string }[]>()
  const seen = new Set<string>()

  let section = ''
  let importer: Map<string, string> | undefined
  let node: string | undefined
  let field = ''
  let dependency = ''

  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      section = line.replace(/:.*$/, '')
      continue
    }
    if (section === 'importers') {
      const top = entryAt(line, 2)
      if (top) {
        importer = new Map()
        importers.set(top.key, importer)
        continue
      }
      const group = entryAt(line, 4)
      if (group) {
        field = group.key
        continue
      }
      if (!DEPENDENCY_SECTIONS.has(field)) continue
      const name = entryAt(line, 6)
      if (name) {
        dependency = name.key
        continue
      }
      const version = entryAt(line, 8)
      if (importer && version?.key === 'version') {
        const id = idOf(dependency, version.value)
        if (id) importer.set(dependency, id)
      }
    } else if (section === 'snapshots') {
      const top = entryAt(line, 2)
      if (top) {
        node = withoutPeers(top.key)
        if (!dependencies.has(node)) dependencies.set(node, [])
        continue
      }
      const group = entryAt(line, 4)
      if (group) {
        field = group.key
        continue
      }
      if (!node || !DEPENDENCY_SECTIONS.has(field)) continue
      const entry = entryAt(line, 6)
      const id = entry && idOf(entry.key, entry.value)
      if (!entry || !id || seen.has(`${node}\0${entry.key}\0${id}`)) continue
      seen.add(`${node}\0${entry.key}\0${id}`)
      dependencies.get(node)?.push({ name: entry.key, id })
    }
  }
  return { importers, dependencies }
}
