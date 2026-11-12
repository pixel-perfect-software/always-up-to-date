import path from 'path'
import { nearestManifestDir } from '@/managers/workspaces'
import {
  CONFIG_SCHEMA_URL,
  INITIAL_CONFIG,
  saveJsonConfig,
} from '@/utils/config'
import { checkIfFileExists } from '@/utils/files'
import logger from '@/utils/logger'

/** What `autd init` does; `../init.ts` loads it when the command runs. */
export const initAction = async (): Promise<void> => {
  // Where `check` reads the config: the nearest package.json's directory,
  // so a run from `packages/a/src` writes the file `check` will find.
  const workingDir = nearestManifestDir(process.cwd())
  logger.info(` Initializing 'always-up-to-date' in ${workingDir}...`)

  const jsonConfigFilePath = path.join(workingDir, '.always-up-to-date.json')

  if (checkIfFileExists(jsonConfigFilePath)) {
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
}
