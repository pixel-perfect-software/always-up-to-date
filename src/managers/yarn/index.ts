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
import { updatePackageJson } from '@/utils/files'

class YarnManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = 'yarn'

  checkPackageVersions = async (
    cwd: string,
  ): Promise<Record<string, PackageInfo>> => {
    logger.starting('Checking package versions', 'Yarn')

    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const command = isRunningInWorkspace
      ? 'outdated --json --recursive'
      : 'outdated --json'

    const commandResult = await this.runCommand(
      this.packageManager,
      command,
      cwd,
    )
    const result = this.parseYarnOutdatedResult(commandResult || '')

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
    logger.starting('Updating packages', 'Yarn')

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
        await updatePackageJson(cwd, packagesToUpdate, outdatedPackages)

        const command = isRunningInWorkspace
          ? `update ${packagesToUpdate.join(' ')} --recursive`
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
        logger.workspace('Yarn')
      }

      return !!hasWorkspaces
    } catch {
      return false
    }
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
