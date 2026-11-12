import fs from 'fs'
import path from 'path'

import type { RunManager } from '@/managers/adapter'
import {
  listsMember,
  packageJsonWorkspaceRoot,
  toPosix,
} from '@/managers/workspaces'
import { StepError } from '@/stepError'
import type { ManifestPlan } from '@/types'
import { type InstalledPackage, rowKey } from '@/utils/installed'
import { updatePackageJson } from '@/utils/manifests'
import type { PeerRequirement } from '@/utils/peers'
import type { SaveStyle } from '@/utils/saveStyle'
import { parseYaml, type YamlNode } from '@/utils/yaml'

/**
 * Yarn 2+ ("berry"). Discovery is native (#107): `yarn.lock` says what each
 * workspace has locked (`readBerryLock`), the registry module what is
 * published, through berry's own `.yarnrc.yml` settings (`yarnrcYml.ts`).
 * No `yarn` command runs for `check`; apply runs `install` and `up -R`.
 */

const isMap = (node: YamlNode | undefined): node is Record<string, YamlNode> =>
  node !== null &&
  node !== undefined &&
  typeof node === 'object' &&
  !Array.isArray(node)

/**
 * The versions berry's `yarn.lock` holds for `rows`, keyed by `rowKey`
 * (#107). Each workspace has an entry keyed `<name>@workspace:<path>` whose
 * `dependencies` give the descriptor yarn resolved for each key it declares,
 * devDependencies included (`ms: "npm:~2.1.1"`, an alias's
 * `m: "npm:ms@^2.0.0"`). The entry whose key list holds `<key>@<descriptor>`
 * gives `version`. A `workspace:` descriptor is another member, so it is
 * linked. A builtin patch (`resolve@patch:…#optional!builtin<compat/resolve>`)
 * is keyed apart from its `npm:` descriptor and locks the same version, so
 * the workspace's own descriptor is read. A row the lockfile lacks (a
 * dependency added since the last install), or every row when there is no
 * readable lockfile, is left out. Checked against yarn 4.18.1's lockfile for
 * testRepos/berry-workspace, 2026-11-03 (`__tests__/fixtures/yarn/berry-workspace.yarn.lock`).
 */
export const readBerryLock = (
  cwd: string,
  rows: { name: string; workspace?: string }[],
): Record<string, InstalledPackage> => {
  let lock: Record<string, YamlNode>
  try {
    lock = parseYaml(fs.readFileSync(path.join(cwd, 'yarn.lock'), 'utf8'))
  } catch {
    return {}
  }

  const versions = new Map<string, string>()
  const workspaces = new Map<string, Record<string, YamlNode>>()
  for (const [keys, entry] of Object.entries(lock)) {
    if (!isMap(entry) || typeof entry.version !== 'string') continue
    for (const descriptor of keys.split(/,\s*/)) {
      versions.set(descriptor, entry.version)
      const at = descriptor.indexOf('@workspace:', 1)
      const dependencies = entry.dependencies
      if (at !== -1 && isMap(dependencies)) {
        workspaces.set(
          descriptor.slice(at + '@workspace:'.length),
          dependencies,
        )
      }
    }
  }

  const installed: Record<string, InstalledPackage> = {}
  for (const row of rows) {
    const descriptor = workspaces.get(row.workspace ?? '.')?.[row.name]
    if (typeof descriptor !== 'string') continue
    if (descriptor.startsWith('workspace:')) {
      installed[rowKey(row)] = { version: '', linked: true }
      continue
    }
    const version = versions.get(`${row.name}@${descriptor}`)
    if (version !== undefined) {
      installed[rowKey(row)] = { version, linked: false }
    }
  }
  return installed
}

/**
 * Peer ranges berry's `yarn.lock` records, keyed by the package they
 * constrain (#232): under PnP there is no node_modules for
 * `readInstalledPeers` to scan. Every locked package counts (berry hoists
 * nothing a scan could miss), each `name@version` once, as the scan counts
 * a copy; a workspace entry's peers count too, as a member linked into
 * node_modules does. The name is the `resolution`'s (an alias's entry
 * resolves to its target). Optional peers count, as in the scan.
 * `peerDependenciesMeta` alone (debug 4.3.7 in the capture) declares no
 * range. Empty without a readable lockfile.
 */
export const readBerryLockPeers = (
  cwd: string,
): Map<string, PeerRequirement[]> => {
  const peers = new Map<string, PeerRequirement[]>()
  let lock: Record<string, YamlNode>
  try {
    lock = parseYaml(fs.readFileSync(path.join(cwd, 'yarn.lock'), 'utf8'))
  } catch {
    return peers
  }
  const seen = new Set<string>()
  for (const entry of Object.values(lock)) {
    if (!isMap(entry)) continue
    const { version, resolution, peerDependencies } = entry
    if (typeof version !== 'string' || typeof resolution !== 'string') continue
    if (!isMap(peerDependencies)) continue
    const at = resolution.indexOf('@', 1)
    if (at === -1) continue
    const name = resolution.slice(0, at)
    if (seen.has(`${name}@${version}`)) continue
    seen.add(`${name}@${version}`)
    for (const [peer, range] of Object.entries(peerDependencies)) {
      if (typeof range !== 'string') continue
      const list = peers.get(peer) ?? []
      list.push({ name, version, range })
      peers.set(peer, list)
    }
  }
  return peers
}

/**
 * Apply: each manifest with beyond-range rows is written first (yarn's save
 * style), then `install --no-immutable` if anything was written, then
 * `up -R <in-range names>`.
 */
export const applyBerry = async (
  run: RunManager,
  cwd: string,
  plan: { withinRange: string[]; manifests: ManifestPlan[] },
  style: SaveStyle,
): Promise<void> => {
  const written = plan.manifests.filter(
    (manifest) => Object.keys(manifest.beyondRange).length > 0,
  )
  for (const manifest of written) {
    await updatePackageJson(
      path.join(cwd, manifest.path),
      manifest.beyondRange,
      style,
    )
  }
  // `--no-immutable`: on CI yarn refuses an install that changes yarn.lock,
  // which is the point here.
  if (written.length > 0) {
    await run(['install', '--no-immutable'], { manifestWritten: true })
  }

  if (plan.withinRange.length > 0) {
    await run(['up', '-R', ...plan.withinRange], {
      manifestWritten: written.length > 0,
    })
  }
}

/**
 * The nearest directory at or above `dir` with a yarn.lock (yarn's
 * `findProjectCwd`), else the nearest ancestor whose `workspaces` list `dir`,
 * else `dir`.
 */
export const yarnProjectDir = (dir: string): string => {
  const start = path.resolve(dir)
  for (let at = start; ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, 'yarn.lock'))) return at
    if (path.dirname(at) === at) return packageJsonWorkspaceRoot(start)
  }
}

/**
 * Berry's project for `dir`: its root (\`yarnProjectDir\`). From a directory
 * the root's \`workspaces\` do not list berry fails, "Usage Error: The
 * nearest package directory … doesn't seem to be part of the project", so
 * this does too, before any command runs.
 */
export const berryProjectRoot = (dir: string): string => {
  const start = path.resolve(dir)
  const root = yarnProjectDir(start)
  if (root === start || listsMember(root, start)) return root
  throw new StepError(
    'detect',
    `${toPosix(path.relative(root, start))} is not listed in "workspaces" of ${path.join(root, 'package.json')}, so yarn does not treat it as part of that project. Add it to "workspaces", or run autd from ${root}.`,
  )
}
