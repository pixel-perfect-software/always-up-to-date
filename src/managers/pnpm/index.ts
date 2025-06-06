import fs from "fs"
import { execAsync } from "@/utils"

import type { PackageInfo } from "@/types"

class PNPMManager {
  checkPackageVersions = async (cwd: string): Promise<void> => {
    console.log("Checking package versions with PNPM...")
    // Check if the current working directory supports PNPM workspaces
    // If it does, we can use the `pnpm outdated -r` command to check for outdated packages recursively
    // If it doesn't, we can use the `pnpm outdated` command to check for outdated packages in the current directory
    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)

    const command = isRunningInWorkspace
      ? "outdated --json -r"
      : "outdated --json"

    const commandResult = await this.runCommand(command, cwd)
    const result: object = JSON.parse(commandResult || "{}")

    if (Object.keys(result).length === 0)
      return console.log("All packages are up to date.")

    console.log("Outdated packages found:")

    Object.entries(result).forEach(([packageName, packageInfo]) => {
      const { current, latest } = packageInfo as PackageInfo
      console.log(
        `${packageName}: current version is ${current}, latest version is ${latest}`,
      )
    })
  }

  updatePackages = async (): Promise<void> => {
    console.log("Updating packages with PNPM...")
    // Implement the logic to update packages using PNPM
    // This could involve running `PNPM upgrade` or similar commands
  }

  checkIfInWorkspace = async (cwd: string): Promise<boolean> => {
    try {
      const workspaceFile = fs.readFileSync(
        `${cwd}/pnpm-workspace.yaml`,
        "utf8",
      )

      console.log(
        "Detected PNPM workspace file. Treating this project as a PNPM workspace.",
      )

      return !!workspaceFile
    } catch {
      return false
    }
  }

  runCommand = async (
    command: string,
    cwd: string,
  ): Promise<string | undefined> => {
    console.log(`Running command "pnpm ${command}"...`)

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
