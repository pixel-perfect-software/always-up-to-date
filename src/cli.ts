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
 * and executes the appropriate command. A failure propagates to `main`
 * (`src/index.ts`), which prints it once.
 */
const run = async (): Promise<void> => {
  await program.parseAsync()
}

export default run
