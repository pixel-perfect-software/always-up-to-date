import fs from 'fs'
import path from 'path'
import semver from 'semver'

/** An installed package's peer range on another package. */
export interface PeerRequirement {
  name: string
  version: string
  range: string
}

const listDir = (dir: string): string[] => {
  try {
    return fs.readdirSync(dir)
  } catch {
    return []
  }
}

/** Package directories directly under a node_modules: `x` and `@scope/x`. */
const packageDirs = (nodeModules: string): string[] =>
  listDir(nodeModules)
    .filter((entry) => !entry.startsWith('.'))
    .flatMap((entry) =>
      entry.startsWith('@')
        ? listDir(path.join(nodeModules, entry)).map((child) =>
            path.join(nodeModules, entry, child),
          )
        : [path.join(nodeModules, entry)],
    )

/**
 * pnpm keeps each package in `.pnpm/<id>/node_modules/<name>`, where the id
 * starts with the name (`/` written as `+`) followed by `@<version>`.
 */
const pnpmStoreDirs = (nodeModules: string): string[] => {
  const store = path.join(nodeModules, '.pnpm')
  return listDir(store).flatMap((id) => {
    const versionAt = id.indexOf('@', 1)
    if (versionAt === -1) return []
    const name = id.slice(0, versionAt).replace('+', '/')
    return [path.join(store, id, 'node_modules', name)]
  })
}

/**
 * What pnpm has installed, from `.pnpm/lock.yaml`'s `packages:` keys: each
 * `name@version`, and each name whose key is not a version (`file:`, git,
 * tarball). pnpm keeps an orphan in `.pnpm` until `modules-cache-max-age`
 * passes; this file no longer lists it (#146). `undefined` without the file.
 */
const pnpmInstalled = (
  nodeModules: string,
): { ids: Set<string>; names: Set<string> } | undefined => {
  let text: string
  try {
    text = fs.readFileSync(path.join(nodeModules, '.pnpm', 'lock.yaml'), 'utf8')
  } catch {
    return undefined
  }
  const ids = new Set<string>()
  const names = new Set<string>()
  let inPackages = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) inPackages = /^packages:\s*$/.test(line)
    const key = inPackages ? /^ {2}'?([^\s']+?)'?:$/.exec(line)?.[1] : undefined
    if (!key) continue
    const versionAt = key.indexOf('@', 1)
    if (versionAt === -1) continue
    const version = key.slice(versionAt + 1)
    if (semver.valid(version)) ids.add(key)
    else names.add(key.slice(0, versionAt))
  }
  return { ids, names }
}

/**
 * Peer ranges declared by the installed packages, keyed by the package they
 * constrain. Read from node_modules (hoisted packages, and pnpm's store), with
 * no network: what is installed now is what an update has to stay
 * compatible with.
 */
export const readInstalledPeers = (
  cwd: string,
): Map<string, PeerRequirement[]> => {
  const nodeModules = path.join(cwd, 'node_modules')
  const peers = new Map<string, PeerRequirement[]>()
  const seen = new Set<string>()
  const installed = pnpmInstalled(nodeModules)

  for (const { dir, store } of [
    ...packageDirs(nodeModules).map((dir) => ({ dir, store: false })),
    ...pnpmStoreDirs(nodeModules).map((dir) => ({ dir, store: true })),
  ]) {
    let manifest: {
      name?: string
      version?: string
      peerDependencies?: Record<string, string>
    }
    try {
      manifest = JSON.parse(
        fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
      )
    } catch {
      continue
    }

    const { name, version, peerDependencies } = manifest
    if (!name || !version || !peerDependencies) continue
    if (
      store &&
      installed &&
      !installed.ids.has(`${name}@${version}`) &&
      !installed.names.has(name)
    )
      continue
    if (seen.has(`${name}@${version}`)) continue
    seen.add(`${name}@${version}`)

    for (const [peer, range] of Object.entries(peerDependencies)) {
      const list = peers.get(peer) ?? []
      list.push({ name, version, range })
      peers.set(peer, list)
    }
  }

  return peers
}
