import detectPackageManager from '@/detectPackageManager'
import { adapterFor, type ManagerAdapter } from '@/managers'
import type { WorkspaceManifest } from '@/managers/adapter'
import { memberAt } from '@/managers/workspaces'
import { locate } from '@/projectLocation'
import type { AlwaysUpToDateConfig, SupportedPackageManager } from '@/types'
import { configFileFor, loadConfig } from '@/utils/config'
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
  /** The project root: the workspace root a member belongs to, else the directory of the nearest package.json (the cwd when there is none). */
  root: string
  /** A run from a workspace member (#123): only its manifest is checked; `update` refuses it and runs from `root`. */
  member?: WorkspaceManifest
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
 * file, and a `detect` `StepError` where the manager refuses the directory.
 *
 * Run from a workspace member (or a directory inside one), the project is the
 * member's workspace root and `member` says which manifest (#123). The config
 * is the member's own file, else the workspace root's; detection reads the
 * declarations between the member and that root and its lockfiles.
 */
export const openProject = (
  cwd: string,
  { pm, cache = true }: { pm?: SupportedPackageManager; cache?: boolean } = {},
): Project => {
  const { dir, workspaceRoot } = locate(cwd)
  const config = loadConfig(dir, workspaceRoot)
  logger.configure(config)
  const adapter = adapterFor(
    detectPackageManager(workspaceRoot, pm, { from: dir }),
  )
  const root = adapter.projectRoot(dir)
  const member = root === dir ? undefined : memberAt(root, dir)
  logger.debug(
    `config: ${configFileFor(dir, workspaceRoot) ?? 'none'}; root ${root}${member ? `; member ${member.path}` : ''}`,
  )
  // Called on the session's first use, so opening a project reads no files.
  const registry = createRegistrySession(cwd, {
    depsDev: config.depsDev,
    cache:
      cache && !cacheDisabledBy(process.env.AUTD_NO_CACHE) ? {} : undefined,
    loadConfig: (dir) => managerRegistryConfig(adapter, dir, processSources()),
  })
  // A manager's own output can hold a registry URL with a token in its path.
  trackRegistries(() => registry.registryConfig())
  return { root, member, config, adapter, registry }
}
