import fs from "fs"

import CommandRunner from "@/commandRunner"
import { logger, updateChecker } from "@/utils"

import type { PackageInfo, SupportedPackageManager } from "@/types"

class BunManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = "bun"

  checkPackageVersions = async (cwd: string): Promise<object> => {
    logger.starting("Checking package versions", "Bun")

    // Check if the current working directory supports Bun workspaces
    // If it does, we can use the `bun outdated --json --filter '*'` command to check for outdated packages recursively
    // If it doesn't, we can use the `bun outdated --json` command to check for outdated packages in the current directory
    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const command = isRunningInWorkspace ? "outdated --filter '*'" : "outdated"

    const commandResult = await this.runCommand(
      this.packageManager,
      command,
      cwd,
    )
    const result = this.parseBunOutdatedOutput(commandResult || "")

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
    logger.starting("Updating packages", "Bun")

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
            ? `update ${packageName} --filter '*'`
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

      // Bun uses the same workspace format as NPM - workspaces can be defined as an array or an object with packages field
      const hasWorkspaces =
        packageJson.workspaces &&
        (Array.isArray(packageJson.workspaces) ||
          (typeof packageJson.workspaces === "object" &&
            packageJson.workspaces.packages))

      if (hasWorkspaces) {
        logger.workspace("Bun")
      }

      return !!hasWorkspaces
    } catch {
      return false
    }
  }

  private parseBunOutdatedOutput = (
    output: string,
  ): Record<string, PackageInfo> => {
    const result: Record<string, PackageInfo> = {}

    // Split output into lines and filter out header/separator lines
    const lines = output
      .split("\n")
      .filter(
        (line) =>
          line.trim() &&
          !line.includes("|---") &&
          !line.includes("Package") &&
          line.includes("|"),
      )

    for (const line of lines) {
      // Split by | and clean up whitespace
      const columns = line
        .split("|")
        .map((col) => col.trim())
        .filter((col) => col)

      if (columns.length >= 4) {
        const packageNameRaw = columns[0]
        const current = columns[1]
        const latest = columns[3]

        // Extract package name (remove dev/prod indicators)
        const packageName = packageNameRaw
          .replace(/\s*\(dev\)|\s*\(prod\)/, "")
          .trim()

        // Only include packages that have updates available (current !== latest)
        if (current !== latest) {
          result[packageName] = {
            name: packageName,
            current,
            latest,
          }
        }
      }
    }

    return result
  }
}

export default BunManager
