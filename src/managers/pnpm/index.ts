import fs from "fs"

import CommandRunner from "@/commandRunner"
import {
  logger,
  updateChecker,
  groupAndSortPackages,
  getSortedGroupNames,
} from "@/utils"

import type { PackageInfo, SupportedPackageManager } from "@/types"

class PNPMManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = "pnpm"

  checkPackageVersions = async (cwd: string): Promise<object> => {
    logger.starting("Checking package versions", "PNPM")

    // Check if the current working directory supports PNPM workspaces
    // If it does, we can use the `pnpm outdated -r` command to check for outdated packages recursively
    // If it doesn't, we can use the `pnpm outdated` command to check for outdated packages in the current directory
    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const command = isRunningInWorkspace
      ? "outdated --json -r"
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
    logger.starting("Updating packages", "PNPM")

    try {
      const outdatedPackages = await this.checkPackageVersions(cwd)

      if (Object.keys(outdatedPackages).length === 0) {
        logger.allUpToDate()
        return
      }
      const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)

      logger.updatingHeader()

      Object.entries(outdatedPackages)
        .filter(([, packageInfo]) => updateChecker(packageInfo))
        .forEach(async ([packageName]) => {
          const command = isRunningInWorkspace
            ? `update ${packageName} -r`
            : `update ${packageName}`

          await this.runCommand(this.packageManager, command, cwd)
        })
    } catch {
      logger.error("An error occurred while checking for outdated packages.")
      return
    }
  }

  checkIfInWorkspace = async (cwd: string): Promise<boolean> => {
    try {
      const workspaceFile = fs.readFileSync(
        `${cwd}/pnpm-workspace.yaml`,
        "utf8",
      )

      logger.workspace("PNPM")

      return !!workspaceFile
    } catch {
      return false
    }
  }
}

export default PNPMManager
