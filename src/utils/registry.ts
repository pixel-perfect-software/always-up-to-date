import npmFetch from 'npm-registry-fetch'
import type { RegistryConfig } from '@/types'
import logger from './logger'

const releaseTimeCache = new Map<string, Record<string, string>>()

export const clearRegistryCache = () => {
  releaseTimeCache.clear()
}

const buildFetchOpts = (config: RegistryConfig): Record<string, unknown> => {
  const opts: Record<string, unknown> = {
    registry: config.registry,
    fullMetadata: true,
  }

  for (const [scope, registry] of Object.entries(config.scopedRegistries)) {
    const key = scope.startsWith('@') ? scope : `@${scope}`
    opts[`${key}:registry`] = registry
  }

  for (const [host, token] of Object.entries(config.authTokens)) {
    opts[`//${host}/:_authToken`] = token
  }

  if (config.alwaysAuth !== undefined) opts['always-auth'] = config.alwaysAuth
  if (config.strictSSL !== undefined) opts['strict-ssl'] = config.strictSSL
  if (config.ca !== undefined) opts.ca = config.ca
  if (config.cafile !== undefined) opts.cafile = config.cafile

  return opts
}

interface Packument {
  time?: Record<string, string>
}

/**
 * Fetch the publish-time map for every version of a package from the registry
 * the package manager has resolved (respects .npmrc / scoped registries / auth).
 * Cached in-memory per CLI run. Network errors degrade to an empty map so that
 * cooldown gating fails open rather than blocking updates.
 */
export const fetchReleaseTimes = async (
  packageName: string,
  config: RegistryConfig,
): Promise<Record<string, string>> => {
  const cached = releaseTimeCache.get(packageName)
  if (cached) return cached

  try {
    const opts = buildFetchOpts(config)
    const packument = (await npmFetch.json(
      packageName,
      opts,
    )) as unknown as Packument
    const time = packument.time ?? {}
    releaseTimeCache.set(packageName, time)
    return time
  } catch (error) {
    logger.debug(
      `Failed to fetch registry metadata for ${packageName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    releaseTimeCache.set(packageName, {})
    return {}
  }
}
