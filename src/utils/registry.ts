import type { RegistryConfig } from '@/types'
import logger from './logger'
import type { RegistryClient } from './registryClient'
import { packumentUrl, registryFor } from './registryRequest'

// The in-flight request is cached, not its result: a workspace asks for the
// same package once per manifest, at the same time.
const releaseTimeCache = new Map<string, Promise<Record<string, string>>>()
const clients = new Map<RegistryConfig, RegistryClient>()

export const clearRegistryCache = () => {
  releaseTimeCache.clear()
  for (const client of clients.values()) client.destroy()
  clients.clear()
}

// The client (and with it node:http, node:https and zlib) loads on the first
// request, so `--version`, `help` and `init` never pay for it.
const clientFor = async (config: RegistryConfig): Promise<RegistryClient> => {
  const existing = clients.get(config)
  if (existing) return existing
  const { createRegistryClient } = await import('./registryClient')
  // Another caller may have created it while the module loaded.
  const raced = clients.get(config)
  if (raced) return raced
  const client = createRegistryClient(config)
  clients.set(config, client)
  return client
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

/**
 * Fetch the publish-time map for every version of a package from the registry
 * the package manager has resolved (respects .npmrc / scoped registries / auth).
 * Cached in-memory per CLI run. Network errors degrade to an empty map so that
 * cooldown gating fails open rather than blocking updates.
 */
const requestReleaseTimes = async (
  packageName: string,
  config: RegistryConfig,
): Promise<Record<string, string>> => {
  try {
    const registry = registryFor(packageName, config)
    const client = await clientFor(config)
    const packument = await client.getJson(
      packumentUrl(packageName, registry),
      registry,
    )
    const time = isRecord(packument) ? packument.time : undefined
    if (!isRecord(time)) return {}
    const times: Record<string, string> = {}
    for (const [version, published] of Object.entries(time)) {
      if (typeof published === 'string') times[version] = published
    }
    return times
  } catch (error) {
    logger.debug(
      `Failed to fetch registry metadata for ${packageName}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
    return {}
  }
}

export const fetchReleaseTimes = (
  packageName: string,
  config: RegistryConfig,
): Promise<Record<string, string>> => {
  let request = releaseTimeCache.get(packageName)
  if (!request) {
    request = requestReleaseTimes(packageName, config)
    releaseTimeCache.set(packageName, request)
  }
  return request
}
