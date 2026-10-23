import fs from 'fs'
import path from 'path'

import type { SuccessCheck } from '@/commandRunner'
import type { ManagerAdapter } from '@/managers/adapter'
import { hasWorkspacesField, readManifest } from '@/managers/workspaces'
import type { PackageInfo } from '@/types'
import { logger } from '@/utils'
import { buildUpdateDescriptors } from '@/utils/files'
import { manifestOverrides } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE, readTextFile, yamlValue } from '@/utils/saveStyle'

/**
 * `yarn outdated` (v1) exits 1 whenever something is outdated, printing a
 * `{"type":"table"}` line. On real errors it also exits 1, with no table.
 */
const isOutdatedReport: SuccessCheck = ({ exitCode, stdout }) => {
  if (exitCode === 0) return true
  if (exitCode !== 1) return false
  return stdout.split('\n').some((line) => {
    try {
      return JSON.parse(line)?.type === 'table'
    } catch {
      return false
    }
  })
}

/**
 * Yarn 2+ ("berry") is identified by the `packageManager` field when it is
 * present, otherwise by a `.yarnrc.yml`, which yarn v1 does not use.
 */
export const isYarnBerry = (cwd: string): boolean => {
  const declared = /^yarn@(\d+)\./.exec(
    String(readManifest(cwd)?.packageManager ?? ''),
  )
  if (declared) return Number(declared[1]) >= 2

  return fs.existsSync(path.join(cwd, '.yarnrc.yml'))
}

/**
 * `yarn outdated --json` (v1): NDJSON lines, one of them a table whose rows
 * are `[name, current, wanted, latest, …]`.
 */
export const parseYarnOutdated = (
  output: string,
): Record<string, PackageInfo> => {
  if (!output || output.trim() === '') {
    return {}
  }

  try {
    const lines = output
      .trim()
      .split('\n')
      .filter((line) => line.trim())
    const parsedLines = lines.map((line) => JSON.parse(line))

    // Find the table data from yarn outdated output
    const tableData = parsedLines.find((item) => item.type === 'table')

    if (!tableData || !tableData.data || !tableData.data.body) {
      return {}
    }

    // Transform table data into a more usable format
    const outdatedPackages: Record<string, PackageInfo> = {}

    tableData.data.body.forEach((row: string[]) => {
      if (row.length >= 4) {
        const [packageName, current, wanted, latest] = row
        outdatedPackages[packageName] = {
          name: packageName,
          current,
          wanted,
          latest,
        }
      }
    })

    return outdatedPackages
  } catch (error) {
    logger.error(`Failed to parse yarn outdated output: ${error}`)
    return {}
  }
}

const yarn: ManagerAdapter = {
  name: 'yarn',
  lockfile: 'yarn.lock',

  readWorkspace: (cwd) => ({
    isWorkspace: hasWorkspacesField(cwd),
    catalogs: [],
  }),

  discover: async (run, _cwd, { isWorkspace }) =>
    parseYarnOutdated(
      await run(
        isWorkspace
          ? ['outdated', '--json', '--recursive']
          : ['outdated', '--json'],
        { isSuccess: isOutdatedReport },
      ),
    ),

  apply: async (run, cwd, { withinRange, beyondRange }) => {
    // yarn rewrites the manifest itself: v1 refuses to upgrade against a
    // pre-written package.json ("Outdated lockfile"). Hand it `name@spec`
    // descriptors instead: the current spec for in-range packages, the new
    // version with the entry's decorator for packages moving past it.
    const { descriptors, notInManifest } = buildUpdateDescriptors(cwd, {
      withinRange,
      newVersions: beyondRange,
      style: yarn.saveStyle(cwd),
    })

    if (notInManifest.length > 0) {
      logger.warn(
        `Skipped ${notInManifest.join(', ')}: not listed in the root package.json.`,
      )
    }

    if (descriptors.length > 0) {
      // v1 is `upgrade`, berry is `up`; neither has `update`. No
      // `--recursive`: v1 ignores it and berry's means "re-resolve
      // transitive dependencies", which rejects explicit ranges.
      const subcommand = isYarnBerry(cwd) ? 'up' : 'upgrade'
      await run([subcommand, ...descriptors], { manifestWritten: false })
    }
  },

  /** berry: `defaultSemverRangePrefix` in .yarnrc.yml, where `''` means exact. Yarn v1 keeps the default. */
  saveStyle: (cwd) => {
    if (!isYarnBerry(cwd)) return DEFAULT_SAVE_STYLE
    const prefix = yamlValue(
      readTextFile(path.join(cwd, '.yarnrc.yml')),
      'defaultSemverRangePrefix',
    )
    if (prefix === undefined) return DEFAULT_SAVE_STYLE
    return { exact: prefix === '', prefix }
  },

  /**
   * `resolutions`, on berry only. Yarn v1 applies them to transitive
   * dependencies but not to a direct one (verified on 1.22.22: the direct
   * dependency still moved), so there is nothing to hold.
   */
  overrides: (cwd) =>
    isYarnBerry(cwd) ? manifestOverrides(cwd, ['resolutions']) : {},
}

export default yarn
