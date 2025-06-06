import fs from "fs"
import { execAsync, logger } from "@/utils"

import type { PackageInfo } from "@/types"

class PNPMManager {
  checkPackageVersions = async (cwd: string): Promise<object> => {
    logger.starting("Checking package versions", "PNPM")

    // Check if the current working directory supports PNPM workspaces
    // If it does, we can use the `pnpm outdated -r` command to check for outdated packages recursively
    // If it doesn't, we can use the `pnpm outdated` command to check for outdated packages in the current directory
    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const command = isRunningInWorkspace
      ? "outdated --json -r"
      : "outdated --json"

    const commandResult = await this.runCommand(command, cwd)
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
    logger.starting("Updating packages", "PNPM")

    try {
      const outdatedPackages = await this.checkPackageVersions(cwd)

      if (Object.keys(outdatedPackages).length === 0) {
        logger.allUpToDate()
        return
      }
      const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)

      Object.entries(outdatedPackages).forEach(async ([packageName]) => {
        const command = isRunningInWorkspace
          ? `update ${packageName} -r`
          : `update ${packageName}`

        await this.runCommand(command, cwd)
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

  runCommand = async (
    command: string,
    cwd: string,
  ): Promise<string | undefined> => {
    logger.command(`pnpm ${command}`)

    try {
      const { stdout } = await execAsync(`pnpm ${command}`, {
        cwd,
        encoding: "utf8",
      })
      return stdout
    } catch (error) {
      const { stdout, stderr } = error as { stdout: string; stderr: string }

      if (stdout && stderr?.length === 0) return stdout
      else if (stderr) {
        throw new Error("An unknown error occurred while running the command.")
      }

      return undefined
    }
  }
}

export default PNPMManager
