import type { Command } from "commander"

/**
 * The Migrate command.
 * This command migrates packages to their latest versions & makes a pull request.
 * TODO: Still need to implement this command.
 */
const migrateCommand = (program: Command) =>
  program
    .command("migrate")
    .description("Migrate packages to their latest versions.")
    .action(async () => {})

export default migrateCommand
