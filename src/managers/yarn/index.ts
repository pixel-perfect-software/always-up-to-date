import fs from 'fs'

import CommandRunner, { type SuccessCheck } from '@/commandRunner'
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
} from '@/utils'
import { buildUpdateDescriptors, checkIfFileExists } from '@/utils/files'

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

// Until #38 moves to an argument array, descriptors pass through a shell,
// where specs like `>=1.2.3` would otherwise be read as redirects.
const shellQuote = (arg: string): string => `'${arg.replaceAll("'", `'\\''`)}'`

class YarnManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = 'yarn'

  checkPackageVersions = async (
    cwd: string,
  ): Promise<Record<string, PackageInfo>> => {
    logger.starting('Checking dependencies', 'yarn')

    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const command = isRunningInWorkspace
      ? 'outdated --json --recursive'
      : 'outdated --json'

    const commandResult = await this.runCommand(
      this.packageManager,
      command,
      cwd,
      isOutdatedReport,
    )
    const result = this.parseYarnOutdatedResult(commandResult || '')

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
        groupedPackages[groupName].map(({ name, info }) => ({
          name,
          current: info.current,
          latest: info.latest,
          releaseAge: releaseAges[name],
        })),
      )
    })

    return result
  }

  updatePackages = async (
    cwd: string,
    targetPackages?: string[],
  ): Promise<UpdateResult[]> => {
    try {
      const outdatedPackages = await this.checkPackageVersions(cwd)

      if (Object.keys(outdatedPackages).length === 0) {
        // checkPackageVersions already printed allUpToDate.
        return []
      }

      await this.checkIfInWorkspace(cwd)
      const results = await filterPackages(outdatedPackages, {
        targetPackages,
        cwd,
      })
      const packagesToUpdate = results
        .filter((r) => r.updated)
        .map((r) => r.name)

      if (
        packagesToUpdate.length === 0 &&
        Object.keys(outdatedPackages).length > 0
      ) {
        logger.noPackagesToUpdate(messages.noPackagesToUpdate)
        logger.cooldownSummary(results)
        return results
      }

      logger.updatingHeader('yarn')
      logger.printUpdatingRows(
        results
          .filter((r) => r.updated)
          .map((r) => ({ name: r.name, current: r.current, latest: r.latest })),
      )

      if (packagesToUpdate.length > 0) {
        // yarn rewrites the manifest itself: v1 refuses to upgrade against a
        // pre-written package.json ("Outdated lockfile"). Hand it `name@spec`
        // descriptors that keep each entry's decorator instead.
        const { descriptors, notInManifest } = buildUpdateDescriptors(
          cwd,
          packagesToUpdate,
          outdatedPackages,
        )

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
          const command = `${subcommand} ${descriptors.map(shellQuote).join(' ')}`

          await this.runCommand(this.packageManager, command, cwd)
        }
      }

      logger.cooldownSummary(results)
      return results
    } catch {
      logger.error('An error occurred while checking for outdated packages.')
      return []
    }
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

  /**
   * Yarn 2+ ("berry") is identified by the `packageManager` field when it is
   * present, otherwise by a `.yarnrc.yml`, which v1 does not use.
   */
  isBerry = (cwd: string): boolean => {
    try {
      const packageJson = JSON.parse(
        fs.readFileSync(`${cwd}/package.json`, 'utf8'),
      )
      const declared = /^yarn@(\d+)\./.exec(packageJson.packageManager ?? '')
      if (declared) return Number(declared[1]) >= 2
    } catch {
      // Unreadable manifest: fall back to the rc file.
    }

    return checkIfFileExists(`${cwd}/.yarnrc.yml`)
  }

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
          const [packageName, current, , latest] = row
          outdatedPackages[packageName] = {
            name: packageName,
            current,
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
