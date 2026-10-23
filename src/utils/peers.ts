import fs from 'fs'
import path from 'path'

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

  for (const dir of [
    ...packageDirs(nodeModules),
    ...pnpmStoreDirs(nodeModules),
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
