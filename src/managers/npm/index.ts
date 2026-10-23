import fs from 'fs'
import path from 'path'

import type { SuccessCheck } from '@/commandRunner'
import type { ManagerAdapter } from '@/managers/adapter'
import { hasWorkspacesField } from '@/managers/workspaces'
import type { PackageInfo } from '@/types'
import { updatePackageJson } from '@/utils/files'
import { loadNpmrc, npmrcBoolean } from '@/utils/npmrcLoader'
import { manifestOverrides } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE } from '@/utils/saveStyle'

/**
 * `npm outdated` exits 1 whenever something is outdated. It also exits 1 on
 * real errors, printing `{ "error": { code, summary } }` instead of a report.
 */
const isOutdatedReport: SuccessCheck = ({ exitCode, stdout }) => {
  if (exitCode === 0) return true
  if (exitCode !== 1) return false
  try {
    const report = JSON.parse(stdout)
    const isNpmError =
      typeof report?.error?.code === 'string' &&
      typeof report?.error?.summary === 'string'
    return typeof report === 'object' && report !== null && !isNpmError
  } catch {
    return false
  }
}

/**
 * Versions package-lock.json records, keyed by install path
 * (`node_modules/ms`). Empty when there is no readable lockfile.
 */
export const readLockedVersions = (cwd: string): Record<string, string> => {
  let packages: Record<string, { version?: unknown }>
  try {
    packages =
      JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'))
        .packages ?? {}
  } catch {
    return {}
  }
  const versions: Record<string, string> = {}
  for (const [location, entry] of Object.entries(packages)) {
    if (typeof entry?.version === 'string') versions[location] = entry.version
  }
  return versions
}

/**
 * `npm outdated --json`: already keyed by name, with `wanted` filled. npm
 * reads `current` from node_modules, so a package that isn't installed (a
 * fresh clone) comes back without one. It takes the version the lockfile
 * records, which is what the other managers report there, or `missing`, as
 * npm's own table prints it, when the lockfile doesn't have it either.
 */
export const parseNpmOutdated = (
  stdout: string,
  locked: Record<string, string> = {},
): Record<string, PackageInfo> => {
  const report: Record<string, PackageInfo> = JSON.parse(stdout || '{}')
  for (const [key, info] of Object.entries(report)) {
    if (info.current) continue
    // An npm: alias is keyed `dj:dayjs@1.11.9` and installed as node_modules/dj.
    const name = key.split(':')[0]
    info.current = locked[`node_modules/${name}`] ?? 'missing'
  }
  return report
}

const npm: ManagerAdapter = {
  name: 'npm',
  lockfile: 'package-lock.json',

  readWorkspace: (cwd) => ({
    isWorkspace: hasWorkspacesField(cwd),
    catalogs: [],
  }),

  discover: async (run, cwd, { isWorkspace }) =>
    parseNpmOutdated(
      await run(
        isWorkspace
          ? ['outdated', '--json', '--workspaces']
          : ['outdated', '--json'],
        { isSuccess: isOutdatedReport },
      ),
      readLockedVersions(cwd),
    ),

  apply: async (run, cwd, { names, beyondRange }, { isWorkspace }) => {
    // npm installs the highest version each range allows. Only packages
    // moving past their range need their manifest spec rewritten first.
    const manifestWritten = Object.keys(beyondRange).length > 0
    if (manifestWritten) {
      await updatePackageJson(cwd, beyondRange, npm.saveStyle(cwd))
    }

    await run(
      isWorkspace ? ['update', ...names, '--workspaces'] : ['update', ...names],
      { manifestWritten },
    )
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

  overrides: (cwd) => manifestOverrides(cwd, ['overrides']),
}

export default npm
