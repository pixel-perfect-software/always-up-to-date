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
  splitUpdates,
  toOutdatedRow,
  toUpdatingRow,
} from '@/utils'
import { updatePackageJson } from '@/utils/files'

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

class NPMManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = 'npm'

  checkPackageVersions = async (
    cwd: string,
  ): Promise<Record<string, PackageInfo>> => {
    logger.starting('Checking dependencies', 'npm')

    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const args = isRunningInWorkspace
      ? ['outdated', '--json', '--workspaces']
      : ['outdated', '--json']

    const commandResult = await this.runStep(
      'discover',
      this.packageManager,
      args,
      cwd,
      { isSuccess: isOutdatedReport },
    )
    const result: Record<string, PackageInfo> = JSON.parse(
      commandResult || '{}',
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

    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const results = await filterPackages(outdatedPackages, {
      targetPackages,
      cwd,
    })
    const { names, beyondRange } = splitUpdates(results)

    if (names.length === 0 && Object.keys(outdatedPackages).length > 0) {
      logger.noPackagesToUpdate(messages.noPackagesToUpdate)
      logger.cooldownSummary(results)
      return results
    }

    logger.updatingHeader('npm')
    logger.printUpdatingRows(
      results.filter((r) => r.updated).map(toUpdatingRow),
    )

    if (names.length > 0) {
      // npm installs the highest version each range allows. Only packages
      // moving past their range need their manifest spec rewritten first.
      const manifestWritten = Object.keys(beyondRange).length > 0
      if (manifestWritten) await updatePackageJson(cwd, beyondRange)

      const args = isRunningInWorkspace
        ? ['update', ...names, '--workspaces']
        : ['update', ...names]

      await this.runStep('apply', this.packageManager, args, cwd, {
        manifestWritten,
      })
    }

    logger.cooldownSummary(results)
    return results
  }

  checkIfInWorkspace = async (cwd: string): Promise<boolean> => {
    try {
      const packageJsonPath = `${cwd}/package.json`
      const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8')
      const packageJson = JSON.parse(packageJsonContent)

      // NPM workspaces can be defined as an array or an object with packages field
      const hasWorkspaces =
        packageJson.workspaces &&
        (Array.isArray(packageJson.workspaces) ||
          (typeof packageJson.workspaces === 'object' &&
            packageJson.workspaces.packages))

      if (hasWorkspaces) {
        logger.workspace('npm')
      }

      return !!hasWorkspaces
    } catch {
      return false
    }
  }
}

export default NPMManager
