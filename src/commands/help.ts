import logger from "@/utils/logger"
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
      logger.info(" Available commands:")
      logger.clean("  📋 check - Check the dependencies of the project.")
      logger.clean(
        "  🔄 update - Update the update-able dependencies of the project.",
      )
      logger.clean("  📝 migrate - Migrate dependencies with breaking changes.")
      logger.clean("  ❓ help - Show this help message.")
      logger.clean("")
      logger.info(
        " Use 'always-up-to-date <command>' to run a specific command.",
      )
    })

export default helpCommand
