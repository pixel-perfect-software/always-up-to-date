import type { Command } from 'commander'
import detectPackageManager from '@/detectPackageManager'
import { PackageManager } from '@/managers'
import logger from '@/utils/logger'
import reportFailure from './reportFailure'

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
      if (options.json) logger.setJsonOutput(true)

      try {
        const packageManagerName = detectPackageManager(workingDir)
        const packageManager = new PackageManager(packageManagerName)

        const result =
          await packageManager.manager.checkPackageVersions(workingDir)
        if (options.json) console.log(JSON.stringify(result, null, 2))
      } catch (error) {
        reportFailure(error, options.json)
      }
    })

export default checkCommand
