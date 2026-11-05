import { type Command, Option } from 'commander'
import type { SupportedPackageManager } from '@/types'
import { noCacheOption, pmOption } from './options'

export interface UpdateOptions {
  dryRun?: boolean
  interactive?: boolean
  json?: boolean
  pm?: SupportedPackageManager
  cache?: boolean
}

/**
 * The "update" command.
 * This command updates the project's dependencies within their package.json
 * ranges, and further when the config allows it.
 *
 * The definition imports only commander and `./options`: the action loads
 * with `await import()`, so `--version` and `help` load none of the pipeline.
 */
const update = (program: Command) =>
  program
    .command('update [packages...]')
    .description('Update the update-able dependencies of the project.')
    .option(
      '--dry-run',
      'Preview which packages would be updated without making changes',
    )
    .option(
      '-i, --interactive',
      'Interactively select which packages to update',
    )
    .addOption(
      new Option('--json', 'Output results as JSON').conflicts('interactive'),
    )
    .addOption(pmOption())
    .addOption(noCacheOption())
    .action(async (packages: string[], options: UpdateOptions) => {
      const { updateAction } = await import('./actions/update')
      await updateAction(packages, options)
    })

export default update
