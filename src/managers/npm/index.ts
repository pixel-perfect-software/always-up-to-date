import fs from 'fs'

import CommandRunner from '@/commandRunner'
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
import { updatePackageJson } from '@/utils/files'

class NPMManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = 'npm'

  checkPackageVersions = async (
    cwd: string,
  ): Promise<Record<string, PackageInfo>> => {
    logger.starting('Checking dependencies', 'npm')

    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const command = isRunningInWorkspace
      ? 'outdated --json --workspaces'
      : 'outdated --json'

    const commandResult = await this.runCommand(
      this.packageManager,
      command,
      cwd,
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

      const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
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

      logger.updatingHeader('npm')
      logger.printUpdatingRows(
        results
          .filter((r) => r.updated)
          .map((r) => ({ name: r.name, current: r.current, latest: r.latest })),
      )

      if (packagesToUpdate.length > 0) {
        await updatePackageJson(cwd, packagesToUpdate, outdatedPackages)

        const command = isRunningInWorkspace
          ? `update ${packagesToUpdate.join(' ')} --workspaces`
          : `update ${packagesToUpdate.join(' ')}`

        await this.runCommand(this.packageManager, command, cwd)
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
