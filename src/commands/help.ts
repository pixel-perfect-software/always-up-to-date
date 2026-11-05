import type { Command } from 'commander'

/**
 * The "help" command.
 * This command shows the help message with available commands.
 */
const helpCommand = (program: Command) =>
  program
    .command('help')
    .description('Show this help message.')
    .action(async () => {
      const { helpAction } = await import('./actions/help')
      await helpAction()
    })

export default helpCommand
