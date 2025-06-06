import fs from "fs"

import CommandRunner from "@/commandRunner"
import { logger, updateChecker } from "@/utils"

import type { PackageInfo, SupportedPackageManager } from "@/types"

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

    Object.entries(result).forEach(([packageName, packageInfo]) => {
      const { current, latest } = packageInfo as PackageInfo
      logger.outdatedPackage(packageName, current, latest)
    })

    return result
  }

  updatePackages = async (cwd: string): Promise<void> => {
    logger.starting("Updating packages", "NPM")

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
            ? `update ${packageName} --workspaces`
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
