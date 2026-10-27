import detectPackageManager from '@/detectPackageManager'
import { adapterFor, type ManagerAdapter } from '@/managers'
import type { AlwaysUpToDateConfig, SupportedPackageManager } from '@/types'
import { loadConfig } from '@/utils/config'
import logger from '@/utils/logger'
import { managerRegistryConfig, processSources } from '@/utils/npmrcLoader'
import { trackRegistries } from '@/utils/redaction'
import { createRegistrySession, type RegistrySession } from '@/utils/registry'

/** `AUTD_NO_CACHE`: anything set except `0` and `false` turns the cache off. */
const cacheDisabledBy = (value: string | undefined): boolean => {
  const setting = value?.trim().toLowerCase()
  return (
    setting !== undefined &&
    setting !== '' &&
    setting !== '0' &&
    setting !== 'false'
  )
}

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
 * `--pm` option) overrides detection. `cache: false` (`--no-cache`) or
 * `AUTD_NO_CACHE=1` keeps registry answers off disk. Throws `ConfigError` for a bad config
 * file.
 */
export const openProject = (
  cwd: string,
  { pm, cache = true }: { pm?: SupportedPackageManager; cache?: boolean } = {},
): Project => {
  const config = loadConfig(cwd)
  logger.configure(config)
  const adapter = adapterFor(detectPackageManager(cwd, pm))
  // Called on the session's first use, so opening a project reads no files.
  const registry = createRegistrySession(cwd, {
    depsDev: config.depsDev,
    cache:
      cache && !cacheDisabledBy(process.env.AUTD_NO_CACHE) ? {} : undefined,
    loadConfig: (dir) => managerRegistryConfig(adapter, dir, processSources()),
  })
  // A manager's own output can hold a registry URL with a token in its path.
  trackRegistries(() => registry.registryConfig())
  return { cwd, config, adapter, registry }
}
