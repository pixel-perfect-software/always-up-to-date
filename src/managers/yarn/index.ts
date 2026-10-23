import fs from 'fs'

import CommandRunner, { type SuccessCheck } from '@/commandRunner'
import { isYarnBerry } from '@/detectPackageManager'
import messages from '@/messages/en.json'
import type {
  PackageInfo,
  SupportedPackageManager,
  UpdateResult,
} from '@/types'
import {
  computeReleaseAges,
  filterPackages,
  getSortedGroupNames,
  groupAndSortPackages,
  logger,
  splitUpdates,
  toOutdatedRow,
  toUpdatingRow,
} from '@/utils'
import { buildUpdateDescriptors } from '@/utils/files'
import { toManifestNames } from '@/utils/manifestNames'
import { readSaveStyle } from '@/utils/saveStyle'

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

class YarnManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = 'yarn'

  checkPackageVersions = async (
    cwd: string,
  ): Promise<Record<string, PackageInfo>> => {
    logger.starting('Checking dependencies', 'yarn')

    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const args = isRunningInWorkspace
      ? ['outdated', '--json', '--recursive']
      : ['outdated', '--json']

    const commandResult = await this.runStep(
      'discover',
      this.packageManager,
      args,
      cwd,
      { isSuccess: isOutdatedReport },
    )
    const result = toManifestNames(
      cwd,
      this.parseYarnOutdatedResult(commandResult || ''),
    )

    if (Object.keys(result).length === 0) {
      logger.allUpToDate()
      return {}
    }

    logger.outdatedHeader()

    const releaseAges = await computeReleaseAges(result, cwd)
    const groupedPackages = groupAndSortPackages(result)
    const sortedGroupNames = getSortedGroupNames(groupedPackages)

    sortedGroupNames.forEach((groupName) => {
      logger.packageGroupHeader(groupName)
      logger.printOutdatedRows(
        groupedPackages[groupName].map(({ name, info }) =>
          toOutdatedRow(name, info, releaseAges[name]),
        ),
      )
    })

    return result
  }

  /**
   * `discovered` is a result from `checkPackageVersions` the caller already
   * has (interactive mode), so `outdated` is not run a second time.
   */
  updatePackages = async (
    cwd: string,
    targetPackages?: string[],
    discovered?: Record<string, PackageInfo>,
  ): Promise<UpdateResult[]> => {
    const outdatedPackages =
      discovered ?? (await this.checkPackageVersions(cwd))

    if (Object.keys(outdatedPackages).length === 0) {
      // checkPackageVersions already printed allUpToDate.
      return []
    }

    await this.checkIfInWorkspace(cwd)
    const results = await filterPackages(outdatedPackages, {
      targetPackages,
      cwd,
      packageManager: this.packageManager,
    })
    const { names, withinRange, beyondRange } = splitUpdates(results)

    if (names.length === 0 && Object.keys(outdatedPackages).length > 0) {
      logger.noPackagesToUpdate(messages.noPackagesToUpdate)
      logger.cooldownSummary(results)
      return results
    }

    logger.updatingHeader('yarn')
    logger.printUpdatingRows(
      results.filter((r) => r.updated).map(toUpdatingRow),
    )

    if (names.length > 0) {
      // yarn rewrites the manifest itself: v1 refuses to upgrade against a
      // pre-written package.json ("Outdated lockfile"). Hand it `name@spec`
      // descriptors instead: the current spec for in-range packages, the new
      // version with the entry's decorator for packages moving past it.
      const { descriptors, notInManifest } = buildUpdateDescriptors(cwd, {
        withinRange,
        newVersions: beyondRange,
        style: readSaveStyle(cwd, this.packageManager),
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
        const subcommand = this.isBerry(cwd) ? 'up' : 'upgrade'
        await this.runStep(
          'apply',
          this.packageManager,
          [subcommand, ...descriptors],
          cwd,
          { manifestWritten: false },
        )
      }
    }

    logger.cooldownSummary(results)
    return results
  }

  checkIfInWorkspace = async (cwd: string): Promise<boolean> => {
    try {
      const packageJsonPath = `${cwd}/package.json`
      const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8')
      const packageJson = JSON.parse(packageJsonContent)

      // Yarn workspaces can be defined as an array or an object with packages field
      const hasWorkspaces =
        packageJson.workspaces &&
        (Array.isArray(packageJson.workspaces) ||
          (typeof packageJson.workspaces === 'object' &&
            packageJson.workspaces.packages))

      if (hasWorkspaces) {
        logger.workspace('yarn')
      }

      return !!hasWorkspaces
    } catch {
      return false
    }
  }

  /** Yarn 2+ ("berry"): see `isYarnBerry`. */
  isBerry = isYarnBerry

  // Parse multiple JSON objects from yarn outdated output
  parseYarnOutdatedResult = (output: string): Record<string, PackageInfo> => {
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
}

export default YarnManager
