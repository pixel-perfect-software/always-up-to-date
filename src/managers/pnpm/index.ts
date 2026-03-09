import fs from 'fs'

import CommandRunner from '@/commandRunner'
import messages from '@/messages/en.json'
import type {
  PackageInfo,
  SupportedPackageManager,
  UpdateResult,
} from '@/types'
import {
  filterPackages,
  getSortedGroupNames,
  groupAndSortPackages,
  logger,
} from '@/utils'
import { updatePackageJson, updatePNPMWorkspaceYAML } from '@/utils/files'

class PNPMManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = 'pnpm'

  checkPackageVersions = async (
    cwd: string,
  ): Promise<Record<string, PackageInfo>> => {
    logger.starting('Checking package versions', 'PNPM')

    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const command = isRunningInWorkspace
      ? 'outdated --json -r'
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

    const groupedPackages = groupAndSortPackages(result)
    const sortedGroupNames = getSortedGroupNames(groupedPackages)

    sortedGroupNames.forEach((groupName) => {
      logger.packageGroupHeader(groupName)
      groupedPackages[groupName].forEach(({ name, info }) => {
        logger.outdatedPackageInGroup(name, info.current, info.latest)
      })
    })

    return result
  }

  updatePackages = async (
    cwd: string,
    targetPackages?: string[],
  ): Promise<UpdateResult[]> => {
    logger.starting('Updating packages', 'PNPM')

    try {
      const outdatedPackages = await this.checkPackageVersions(cwd)

      if (Object.keys(outdatedPackages).length === 0) {
        logger.allUpToDate()
        return []
      }

      const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
      const results = filterPackages(outdatedPackages, targetPackages)
      const packagesToUpdate = results
        .filter((r) => r.updated)
        .map((r) => r.name)

      if (
        packagesToUpdate.length === 0 &&
        Object.keys(outdatedPackages).length > 0
      ) {
        logger.info(messages.noPackagesToUpdate)
        return results
      }

      logger.updatingHeader()

      if (packagesToUpdate.length > 0) {
        if (isRunningInWorkspace) {
          await updatePNPMWorkspaceYAML(cwd, packagesToUpdate, outdatedPackages)
        } else {
          await updatePackageJson(cwd, packagesToUpdate, outdatedPackages)
        }

        const command = isRunningInWorkspace
          ? `update ${packagesToUpdate.join(' ')} -r`
          : `update ${packagesToUpdate.join(' ')}`

        await this.runCommand(this.packageManager, command, cwd)
      }

      return results
    } catch {
      logger.error('An error occurred while checking for outdated packages.')
      return []
    }
  }

  checkIfInWorkspace = async (cwd: string): Promise<boolean> => {
    try {
      const workspaceFile = fs.readFileSync(
        `${cwd}/pnpm-workspace.yaml`,
        'utf8',
      )

      logger.workspace('PNPM')

      return !!workspaceFile
    } catch {
      return false
    }
  }
}

export default PNPMManager
