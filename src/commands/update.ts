import detectPackageManager from "@/detectPackageManager"
import { PackageManager } from "@/managers"
import type { Command } from "commander"

const workingDir = process.cwd()

/**
 * The "update" command.
 * This command updates the update-able dependencies of the project
 * to their latest versions.
 */
const update = (program: Command) =>
  program
    .command("update")
    .description("Update the update-able dependencies of the project.")
    .action(async () => {
      const packageManagerName = detectPackageManager(workingDir)
      const packageManager = new PackageManager(packageManagerName)

      packageManager.manager.updatePackages(workingDir)
    })

export default update
