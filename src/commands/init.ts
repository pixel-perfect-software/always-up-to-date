import fs from "fs"
import path from "path"
import {
  checkIfFileExists,
  logger,
  DEFAULT_CONFIG,
  saveJsonConfig,
} from "@/utils"
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

      const jsonConfigFilePath = path.join(
        workingDir,
        ".always-up-to-date.json",
      )
      const envConfigFilePath = path.join(workingDir, ".always-up-to-date")

      // Check if either config file already exists
      if (
        checkIfFileExists(jsonConfigFilePath) ||
        checkIfFileExists(envConfigFilePath)
      ) {
        return logger.info(
          `  Project already initialized with 'always-up-to-date'.`,
        )
      }

      // Create the new JSON configuration file
      saveJsonConfig(DEFAULT_CONFIG, jsonConfigFilePath)

      return logger.clean(
        `  ✅ Created configuration file at ${jsonConfigFilePath}`,
      )
    })

export default initCommand
