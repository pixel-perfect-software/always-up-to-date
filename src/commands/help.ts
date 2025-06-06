import type { Command } from "commander"

/**
 * The "help" command.
 * This command shows the help message with available commands.
 */
const helpCommand = (program: Command) =>
  program
    .command("help")
    .description("Show this help message.")
    .action(() => {
      console.log("Available commands:")
      console.log("  check - Check the dependencies of the project.")
      console.log(
        "  update - Update the update-able dependencies of the project.",
      )
      console.log("  help - Show this help message.")
    })

export default helpCommand
