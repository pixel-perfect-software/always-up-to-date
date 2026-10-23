import detectPackageManager from '@/detectPackageManager'
import { adapterFor, type ManagerAdapter } from '@/managers'
import type { AlwaysUpToDateConfig } from '@/types'
import { loadConfig } from '@/utils/config'
import logger from '@/utils/logger'

/** One command run's project, loaded once: where it is, its config, its manager. */
export interface Project {
  cwd: string
  config: AlwaysUpToDateConfig
  adapter: ManagerAdapter
}

/**
 * Loads the config, configures the logger from it, then detects the manager,
 * in that order so detection can log by the config's settings. Throws
 * `ConfigError` for a bad config file.
 */
export const openProject = (cwd: string): Project => {
  const config = loadConfig(cwd)
  logger.configure(config)
  return { cwd, config, adapter: adapterFor(detectPackageManager(cwd)) }
}
