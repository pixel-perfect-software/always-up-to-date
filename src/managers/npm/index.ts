import fs from "fs"

import CommandRunner from "@/commandRunner"
import {
  logger,
  updateChecker,
  groupAndSortPackages,
  getSortedGroupNames,
} from "@/utils"

import messages from "@/messages/en.json"
import type { PackageInfo, SupportedPackageManager } from "@/types"
import { updatePackageJson } from "@/utils/files"

class NPMManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = "npm"

  checkPackageVersions = async (cwd: string): Promise<object> => {
    logger.starting("Checking package versions", "NPM")

    // Check if the current working directory supports NPM workspaces
    // If it does, we can use the `npm outdated --json --workspaces` command to check for outdated packages recursively
    // If it doesn't, we can use the `npm outdated --json` command to check for outdated packages in the current directory
    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const command = isRunningInWorkspace
      ? "outdated --json --workspaces"
      : "outdated --json"

    const commandResult = await this.runCommand(
      this.packageManager,
      command,
      cwd,
    )
    const result: object = JSON.parse(commandResult || "{}")

    if (Object.keys(result).length === 0) {
      logger.allUpToDate()
      return {}
    }

    logger.outdatedHeader()

    // Group and sort packages for better readability
    const groupedPackages = groupAndSortPackages(
      result as Record<string, PackageInfo>,
    )
    const sortedGroupNames = getSortedGroupNames(groupedPackages)

    sortedGroupNames.forEach((groupName) => {
      logger.packageGroupHeader(groupName)
      groupedPackages[groupName].forEach(({ name, info }) => {
        logger.outdatedPackageInGroup(name, info.current, info.latest)
      })
    })

    return result
  }

  updatePackages = async (cwd: string): Promise<void> => {
    logger.starting("Updating packages", "NPM")

    try {
      const outdatedPackages = await this.checkPackageVersions(cwd)

      if (Object.keys(outdatedPackages).length === 0)
        return logger.allUpToDate()

      const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)

      logger.updatingHeader()

      const packagesToUpdate = Object.entries(outdatedPackages)
        .filter(([name, packageInfo]) =>
          updateChecker({ name, ...packageInfo }),
        )
        .map(([packageName]) => packageName)

      if (
        packagesToUpdate.length === 0 &&
        Object.keys(outdatedPackages)?.length > 0
      )
        return logger.info(messages.noPackagesToUpdate)

      if (packagesToUpdate.length > 0) {
        updatePackageJson(
          cwd,
          packagesToUpdate,
          outdatedPackages as Record<string, PackageInfo>,
        )

        const command = isRunningInWorkspace
          ? `update ${packagesToUpdate.join(" ")} --workspaces` // npm example
          : `update ${packagesToUpdate.join(" ")}`

        await this.runCommand(this.packageManager, command, cwd)
      }
    } catch {
      logger.error("An error occurred while checking for outdated packages.")
      return
    }
  }

  checkIfInWorkspace = async (cwd: string): Promise<boolean> => {
    try {
      const packageJsonPath = `${cwd}/package.json`
      const packageJsonContent = fs.readFileSync(packageJsonPath, "utf8")
      const packageJson = JSON.parse(packageJsonContent)

      // NPM workspaces can be defined as an array or an object with packages field
      const hasWorkspaces =
        packageJson.workspaces &&
        (Array.isArray(packageJson.workspaces) ||
          (typeof packageJson.workspaces === "object" &&
            packageJson.workspaces.packages))

      if (hasWorkspaces) {
        logger.workspace("NPM")
      }

      return !!hasWorkspaces
    } catch {
      return false
    }
  }
}

export default NPMManager
