/**
 * Basic CLI for the package.
 * Commands:
 * - init - Initialize the project with a JSON configuration file.
 * - check - Check the dependencies of the project.
 * - update - Update the dependencies of the project.
 * - help [command] - commander's own.
 */
import { Command } from 'commander'
import { checkCommand, initCommand, updateCommand } from '@/commands'
import packageJson from '../package.json'

// Create a program instance
export const program = new Command()

// Configure program metadata
program
  .name('autd')
  .description(packageJson.description)
  .version(packageJson.version)

// Register commands
checkCommand(program)
initCommand(program)
updateCommand(program)

/**
 * Run the CLI program.
 * This function parses the command line arguments
 * and executes the appropriate command.
 */
const run = async (): Promise<void> => {
  try {
    await program.parseAsync()
  } catch (error) {
    console.error('An error occurred while running the CLI:', error)
    throw error
  }
}

export default run
