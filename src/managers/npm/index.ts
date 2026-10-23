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

/** `npm outdated --json`: already keyed by name, with `wanted` filled. */
export const parseNpmOutdated = (stdout: string): Record<string, PackageInfo> =>
  JSON.parse(stdout || '{}')

const npm: ManagerAdapter = {
  name: 'npm',
  lockfile: 'package-lock.json',

  readWorkspace: (cwd) => ({
    isWorkspace: hasWorkspacesField(cwd),
    catalogs: [],
  }),

  discover: async (run, _cwd, { isWorkspace }) =>
    parseNpmOutdated(
      await run(
        isWorkspace
          ? ['outdated', '--json', '--workspaces']
          : ['outdated', '--json'],
        { isSuccess: isOutdatedReport },
      ),
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
