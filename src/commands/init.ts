import fs from "fs"
import path from "path"
import { checkIfFileExists, logger } from "@/utils"
import type { Command } from "commander"

const workingDir = process.cwd()

/**
 * The "init" command.
 * This command initializes the library with a basic setup.
 */
const initCommand = (program: Command) =>
  program
    .command("init")
    .description("Initialize the 'always-up-to-date' with a basic setup.")
    .action(() => {
      logger.info(` Initializing 'always-up-to-date' in ${workingDir}...`)

      const configFilePath = path.join(workingDir, ".always-up-to-date")
      const defaultConfig = `# Configuration for 'always-up-to-date'`

      if (checkIfFileExists(configFilePath)) {
        return logger.info(
          `  Project already initialized with 'always-up-to-date'.`,
        )
      }

      fs.writeFileSync(configFilePath, defaultConfig, "utf8")

      return logger.clean(
        `  ✅ Created configuration file at ${configFilePath}`,
      )
    })

export default initCommand
