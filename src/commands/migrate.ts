import type { Command } from "commander"

/**
 * The Migrate command.
 * This command migrates packages to their latest versions & makes necessary changes.
 * It should be used with caution as it can potentially break your project if not used carefully.
 */
const migrateCommand = (program: Command) =>
  program
    .command("migrate")
    .description("Migrate packages to their latest versions.")
    .action(async () => {})

export default migrateCommand
