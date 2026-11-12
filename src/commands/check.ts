import type { Command } from 'commander'
import type { SupportedPackageManager } from '@/types'
import { noCacheOption, pmOption } from './options'

export interface CheckOptions {
  json?: boolean
  pm?: SupportedPackageManager
  cache?: boolean
}

/**
 * The "check" command.
 * This command checks the dependencies of the project
 * and reports any outdated packages.
 *
 * The definition imports only commander and `./options`: the action loads
 * with `await import()`, so `--version` and `help` load none of the pipeline.
 */
const checkCommand = (program: Command) =>
  program
    .command('check')
    .description(
      'List outdated dependencies and what update would do with each',
    )
    .option(
      '--json',
      'Output a versioned JSON document (schema/output.schema.json)',
    )
    .addOption(pmOption())
    .addOption(noCacheOption())
    .action(async (options: CheckOptions) => {
      const { checkAction } = await import('./actions/check')
      await checkAction(options)
    })

export default checkCommand
