/**
 * Basic CLI for the package.
 * Commands:
 * - init - Initialize the project with a JSON configuration file.
 * - check - Check the dependencies of the project.
 * - update - Update the update-able dependencies of the project.
 * - help - Show this help message.
 */
import { Command } from "commander"
import { checkCommand, helpCommand, updateCommand } from "@/commands"
import packageJson from "../package.json"
import initCommand from "@/commands/init"

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
 * and executes the appropriate command.
 */
const run = async (): Promise<void> => {
  try {
    await program.parseAsync()
  } catch (error) {
    console.error("An error occurred while running the CLI:", error)
    throw error
  }
}

export default run
