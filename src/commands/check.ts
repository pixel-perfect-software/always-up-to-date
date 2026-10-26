import type { Command } from 'commander'
import { check } from '@/pipeline'
import { openProject, type Project } from '@/project'
import type { SupportedPackageManager } from '@/types'
import logger from '@/utils/logger'
import { pmOption } from './options'
import reportFailure from './reportFailure'

const workingDir = process.cwd()

interface CheckOptions {
  json?: boolean
  pm?: SupportedPackageManager
}

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
    .addOption(pmOption())
    .action(async (options: CheckOptions) => {
      if (options.json) logger.setJsonOutput(true)

      let project: Project | undefined
      try {
        project = openProject(workingDir, { pm: options.pm })

        const result = await check(project)
        if (options.json) console.log(JSON.stringify(result, null, 2))
      } catch (error) {
        reportFailure(error, options.json)
      } finally {
        project?.registry.close()
      }
    })

export default checkCommand
