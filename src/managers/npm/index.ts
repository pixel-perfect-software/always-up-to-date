import fs from 'fs'
import path from 'path'

import type { ManagerAdapter } from '@/managers/adapter'
import {
  packageJsonWorkspace,
  packageJsonWorkspaceRoot,
} from '@/managers/workspaces'
import { updatePackageJson } from '@/utils/files'
import { type InstalledPackage, rowKey } from '@/utils/installed'
import { isRecord } from '@/utils/isRecord'
import { loadNpmrc, npmrcBoolean } from '@/utils/npmrcLoader'
import { manifestOverrides } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE } from '@/utils/saveStyle'

/** One `packages` entry of package-lock.json (lockfileVersion 2 and 3). */
interface LockedEntry {
  version?: unknown
  link?: unknown
  resolved?: unknown
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

  // #107: a project with package-lock.json and no node_modules (never
  // installed, `npm ci` not run yet, node_modules removed) has its installed
  // versions in the lockfile. With node_modules, node_modules decides.
  installedFromLockfile: (cwd) =>
    !fs.existsSync(path.join(cwd, 'node_modules')) &&
    fs.existsSync(path.join(cwd, 'package-lock.json'))
      ? { file: 'package-lock.json', read: readLockedPackages }
      : undefined,

  overrides: (cwd) => manifestOverrides(cwd, ['overrides']),
}

export default npm
