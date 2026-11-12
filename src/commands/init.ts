import type { Command } from 'commander'

/**
 * The "init" command.
 * This command initializes the library with a basic setup.
 */
const initCommand = (program: Command) =>
  program
    .command('init')
    .description('Create .always-up-to-date.json')
    .action(async () => {
      const { initAction } = await import('./actions/init')
      await initAction()
    })

export default initCommand
