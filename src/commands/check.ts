import detectPackageManager from "@/detectPackageManager"
import { PackageManager } from "@/managers"

import type { Command } from "commander"

const workingDir = process.cwd()

/**
 * The "check" command.
 * This command checks the dependencies of the project
 * and reports any outdated packages.
 */
const checkCommand = (program: Command) =>
  program
    .command("check")
    .description("Check the dependencies of the project.")
    .action(async () => {
      const packageManagerName = detectPackageManager(workingDir)
      const packageManager = new PackageManager(packageManagerName)

      packageManager.manager.checkPackageVersions(workingDir)
    })

export default checkCommand
