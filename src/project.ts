import detectPackageManager from '@/detectPackageManager'
import { adapterFor, type ManagerAdapter } from '@/managers'
import type { AlwaysUpToDateConfig, SupportedPackageManager } from '@/types'
import { loadConfig } from '@/utils/config'
import logger from '@/utils/logger'
import { managerRegistryConfig, processSources } from '@/utils/npmrcLoader'
import { createRegistrySession, type RegistrySession } from '@/utils/registry'

/** One command run's project, loaded once: where it is, its config, its manager. */
export interface Project {
  cwd: string
  config: AlwaysUpToDateConfig
  adapter: ManagerAdapter
  /** The run's registry config and client, loaded on first use; commands close it. */
  registry: RegistrySession
}

/**
 * Loads the config, configures the logger from it, then detects the manager,
 * in that order so detection can log by the config's settings. `pm` (the
 * `--pm` option) overrides detection. Throws `ConfigError` for a bad config
 * file.
 */
export const openProject = (
  cwd: string,
  { pm }: { pm?: SupportedPackageManager } = {},
): Project => {
  const config = loadConfig(cwd)
  logger.configure(config)
  const adapter = adapterFor(detectPackageManager(cwd, pm))
  return {
    cwd,
    config,
    adapter,
    // Called on the session's first use, so opening a project reads no files.
    registry: createRegistrySession(cwd, {
      depsDev: config.depsDev,
      loadConfig: (dir) =>
        managerRegistryConfig(adapter, dir, processSources()),
    }),
  }
}
