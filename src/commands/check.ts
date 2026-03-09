import type { Command } from 'commander'
import detectPackageManager from '@/detectPackageManager'
import { PackageManager } from '@/managers'

const workingDir = process.cwd()

/**
 * The "check" command.
 * This command checks the dependencies of the project
 * and reports any outdated packages.
 */
const checkCommand = (program: Command) =>
  program
    .command('check')
    .description('Check the dependencies of the project.')
    .option('--json', 'Output results as JSON')
    .action(async (options: { json?: boolean }) => {
      const packageManagerName = detectPackageManager(workingDir)
      const packageManager = new PackageManager(packageManagerName)

      if (options.json) {
        // Suppress logger output and print raw JSON
        const { default: logger } = await import('@/utils/logger')
        logger.setQuiet(true)

        const result =
          await packageManager.manager.checkPackageVersions(workingDir)
        console.log(JSON.stringify(result, null, 2))
      } else {
        await packageManager.manager.checkPackageVersions(workingDir)
      }
    })

export default checkCommand
