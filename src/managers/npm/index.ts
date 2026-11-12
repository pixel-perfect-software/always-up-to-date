import fs from 'fs'
import path from 'path'

import type { ManagerAdapter } from '@/managers/adapter'
import {
  packageJsonWorkspace,
  packageJsonWorkspaceRoot,
} from '@/managers/workspaces'
import type { ReleaseAgeGate } from '@/types'
import { type InstalledPackage, rowKey } from '@/utils/installed'
import { isRecord } from '@/utils/isRecord'
import { updatePackageJson } from '@/utils/manifests'
import { npmrcBoolean } from '@/utils/npmrc'
import { loadNpmrc } from '@/utils/npmrcLoader'
import { manifestOverrides } from '@/utils/overrides'
import type { PeerRequirement } from '@/utils/peers'
import { DEFAULT_SAVE_STYLE } from '@/utils/saveStyle'

/** One `packages` entry of package-lock.json (lockfileVersion 2 and 3). */
interface LockedEntry {
  version?: unknown
  link?: unknown
  resolved?: unknown
  peerDependencies?: unknown
}

const readLockfile = (cwd: string): Record<string, LockedEntry> | undefined => {
  try {
    const packages = JSON.parse(
      fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'),
    ).packages
    return isRecord(packages)
      ? (packages as Record<string, LockedEntry>)
      : undefined
  } catch {
    return undefined
  }
}

/**
 * The versions package-lock.json records for `rows`, keyed by `rowKey`, as
 * node_modules would hold them (#107): a member's own
 * `<member>/node_modules/<key>` first, then the root's `node_modules/<key>`
 * (npm hoists there). A `link: true` entry is a workspace member, so it is
 * `linked`. A row the lockfile doesn't record is left out, and so is every
 * row when there is no readable lockfile. Paths in the lockfile are POSIX,
 * as workspace paths are.
 */
export const readLockedPackages = (
  cwd: string,
  rows: { name: string; workspace?: string }[],
): Record<string, InstalledPackage> => {
  const packages = readLockfile(cwd)
  if (!packages) return {}
  const installed: Record<string, InstalledPackage> = {}
  for (const row of rows) {
    const dir = row.workspace ?? '.'
    const locations = [
      ...(dir === '.' ? [] : [`${dir}/node_modules/${row.name}`]),
      `node_modules/${row.name}`,
    ]
    for (const location of locations) {
      const entry = packages[location]
      if (!isRecord(entry)) continue
      if (entry.link === true) {
        const target =
          typeof entry.resolved === 'string'
            ? packages[entry.resolved]
            : undefined
        installed[rowKey(row)] = {
          version: typeof target?.version === 'string' ? target.version : '',
          linked: true,
        }
        break
      }
      if (typeof entry.version === 'string') {
        installed[rowKey(row)] = { version: entry.version, linked: false }
        break
      }
    }
  }
  return installed
}

/** A package directly under the root's node_modules: `x` or `@scope/x`. */
const HOISTED = /^node_modules\/((?:@[^/]+\/)?[^/]+)$/

/**
 * Peer ranges package-lock.json records for the packages under the root's
 * node_modules, keyed by the package they constrain (#232): what
 * `readInstalledPeers` reads from `<cwd>/node_modules` when it exists. So,
 * like that scan, only hoisted entries count (`node_modules/<name>`, not a
 * nested `node_modules/a/node_modules/b` or a member's own
 * `<member>/node_modules/<name>`), a `link: true` entry (a workspace member)
 * counts with the member entry it resolves to, and optional peers count too.
 * Empty without a readable lockfile.
 */
export const readLockedPeers = (
  cwd: string,
): Map<string, PeerRequirement[]> => {
  const peers = new Map<string, PeerRequirement[]>()
  const packages = readLockfile(cwd)
  if (!packages) return peers
  const seen = new Set<string>()
  for (const [location, found] of Object.entries(packages)) {
    const name = HOISTED.exec(location)?.[1]
    if (!name || !isRecord(found)) continue
    const entry =
      found.link === true && typeof found.resolved === 'string'
        ? packages[found.resolved]
        : found
    if (!isRecord(entry)) continue
    const { version, peerDependencies } = entry
    if (typeof version !== 'string' || !isRecord(peerDependencies)) continue
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
 * npm's release-age gate (#168), from its `.npmrc` view (`npm_config_*`
 * included), which autd never overrides. Verified on npm 12.2.1, 2026-11-03,
 * with `npm install` against a local registry with set publish times
 * (n01-n11, the cases in `__tests__/releaseAgeGates.test.ts`): off unless set (n01);
 * `min-release-age` in days, fractions allowed (n02, n11; `npm_config_*`
 * too, n09); `min-release-age-exclude` holds names and globs (n03-n05), and
 * a `name@version` entry exempts nothing (n06); `before` is an inclusive
 * cutoff (n10). A version with no publish time is let through (n08); with
 * nothing old enough npm fails (`ENOVERSIONS`, n07).
 */
export const npmReleaseAgeGate = (
  values: Record<string, unknown>,
): ReleaseAgeGate | undefined => {
  const days = Number(values['min-release-age'])
  const minutes = Number.isFinite(days) && days > 0 ? days * 1440 : 0
  const before =
    typeof values.before === 'string' ? Date.parse(values.before) : Number.NaN
  const notAfter = Number.isNaN(before)
    ? undefined
    : new Date(before).toISOString()
  if (minutes === 0 && notAfter === undefined) return undefined
  const exclude = values['min-release-age-exclude']
  const patterns = (Array.isArray(exclude) ? exclude : [exclude]).filter(
    (item): item is string => typeof item === 'string' && item !== '',
  )
  return {
    setting: minutes > 0 ? 'min-release-age' : 'before',
    minutes,
    scopes: {},
    // A pattern keeps any `@version` in its name, so it matches no package.
    exempt: patterns.map((pattern) => ({ name: pattern, glob: 'segment' })),
    missingTime: 'allowed',
    ...(notAfter ? { notAfter } : {}),
  }
}

const npm: ManagerAdapter = {
  name: 'npm',
  lockfile: 'package-lock.json',

  projectRoot: packageJsonWorkspaceRoot,

  readWorkspace: (cwd) => ({
    ...packageJsonWorkspace(cwd),
    catalogs: {},
  }),

  apply: async (run, cwd, { names, manifests }) => {
    // npm installs the highest version each range allows. Only packages
    // moving past their range need their manifest spec rewritten first, in
    // the manifest that owns it.
    const style = npm.saveStyle(cwd)
    const written = manifests.filter(
      (m) => Object.keys(m.beyondRange).length > 0,
    )
    for (const m of written) {
      await updatePackageJson(path.join(cwd, m.path), m.beyondRange, style)
    }

    // `npm update` at the root moves every workspace's ranges too;
    // `--workspaces` would skip the root's own.
    await run(['update', ...names], { manifestWritten: written.length > 0 })
  },

  /** `save-exact` / `save-prefix` in .npmrc. */
  saveStyle: (cwd) => {
    const npmrc = loadNpmrc(cwd)
    const prefix = npmrc['save-prefix']
    return {
      exact: npmrcBoolean(npmrc['save-exact']) ?? false,
      prefix: typeof prefix === 'string' ? prefix : DEFAULT_SAVE_STYLE.prefix,
    }
  },

  pinning: () => ({ install: ['install'] }),

  // #200: npm-pick-manifest prefers a version whose `engines.node` fits the
  // running Node (probed on npm 12.2.2 and 11.19.1, 2026-11-08).
  skipsEnginesExcluded: () => true,

  releaseAgeGate: (_cwd, _sources, npmrc) => npmReleaseAgeGate(npmrc.values),

  // #107: a project with package-lock.json and no node_modules (never
  // installed, `npm ci` not run yet, node_modules removed) has its installed
  // versions in the lockfile. With node_modules, node_modules decides.
  installedFromLockfile: (cwd) =>
    !fs.existsSync(path.join(cwd, 'node_modules')) &&
    fs.existsSync(path.join(cwd, 'package-lock.json'))
      ? {
          file: 'package-lock.json',
          read: readLockedPackages,
          peers: readLockedPeers,
        }
      : undefined,

  overrides: (cwd) => manifestOverrides(cwd, ['overrides']),
}

export default npm
