import type { Command } from "commander"

/**
 * The "update" command.
 * This command updates the update-able dependencies of the project
 * to their latest versions.
 */
const update = (program: Command) =>
  program
    .command("update")
    .description("Update the update-able dependencies of the project.")
    .action(async () => {
      console.log("do update")
    })

export default update
