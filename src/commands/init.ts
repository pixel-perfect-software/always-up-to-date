import type { Command } from 'commander'
import path from 'path'
import { nearestManifestDir } from '@/managers/workspaces'
import { checkIfFileExists, logger, saveJsonConfig } from '@/utils'
import { CONFIG_SCHEMA_URL, INITIAL_CONFIG } from '@/utils/config'

/**
 * The "init" command.
 * This command initializes the library with a basic setup.
 */
const initCommand = (program: Command) =>
  program
    .command('init')
    .description("Initialize the 'always-up-to-date' with a basic setup.")
    .action(() => {
      // Where `check` reads the config: the nearest package.json's directory,
      // so a run from `packages/a/src` writes the file `check` will find.
      const workingDir = nearestManifestDir(process.cwd())
      logger.info(` Initializing 'always-up-to-date' in ${workingDir}...`)

      const jsonConfigFilePath = path.join(
        workingDir,
        '.always-up-to-date.json',
      )
      const envConfigFilePath = path.join(workingDir, '.always-up-to-date')

      // Check if either config file already exists
      if (
        checkIfFileExists(jsonConfigFilePath) ||
        checkIfFileExists(envConfigFilePath)
      ) {
        return logger.info(
          `  Project already initialized with 'always-up-to-date'.`,
        )
      }

      // Create the new JSON configuration file with a $schema reference
      // for IDE autocomplete + validation.
      saveJsonConfig(
        { $schema: CONFIG_SCHEMA_URL, ...INITIAL_CONFIG },
        jsonConfigFilePath,
      )

      return logger.clean(
        `  ✅ Created configuration file at ${jsonConfigFilePath}`,
      )
    })

export default initCommand
