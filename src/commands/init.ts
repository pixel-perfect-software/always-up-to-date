import type { Command } from 'commander'

/**
 * The "init" command.
 * This command initializes the library with a basic setup.
 */
const initCommand = (program: Command) =>
  program
    .command('init')
    .description("Initialize the 'always-up-to-date' with a basic setup.")
    .action(async () => {
      const { initAction } = await import('./actions/init')
      await initAction()
    })

export default initCommand
