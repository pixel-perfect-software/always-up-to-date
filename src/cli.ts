/**
 * Basic CLI for the package.
 * Commands:
 * - init - Initialize the project with a JSON configuration file.
 * - check - Check the dependencies of the project.
 * - update - Update the update-able dependencies of the project.
 * - help - Show this help message.
 */
import { Command } from 'commander'
import {
  checkCommand,
  helpCommand,
  initCommand,
  updateCommand,
} from '@/commands'
import packageJson from '../package.json'

// Create a program instance
const program = new Command()

// Configure program metadata
program
  .name(packageJson.name)
  .description(packageJson.description)
  .version(packageJson.version)

// Register commands
checkCommand(program)
helpCommand(program)
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
