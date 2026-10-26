import semver from 'semver'
import type {
  PackageLookup,
  RegistryConfig,
  RegistryPackage,
  RegistryVersion,
} from '@/types'
import { createLimiter } from './limiter'
import logger from './logger'
import type { RegistryClient } from './registryClient'
import {
  parseDepsDevPackage,
  parseDistTags,
  parsePackument,
} from './registryDocuments'
import {
  ABBREVIATED_ACCEPT,
  DEFAULT_ENDPOINTS,
  depsDevUrl,
  distTagsUrl,
  isPublicNpmRegistry,
  isValidPackageName,
  packumentUrl,
  type RegistryEndpoints,
  registryFor,
} from './registryRequest'

export interface RegistryReaderOptions {
  registryConfig: RegistryConfig
  client: RegistryClient
  /** Ask deps.dev about public npm names. */
  depsDev: boolean
  endpoints?: RegistryEndpoints
}

export interface RegistryReader {
  /** Never rejects for a network, HTTP or parse failure; those are `ok: false`. */
  lookup(name: string): Promise<PackageLookup>
}

// deps.dev is an accelerator with a fallback: a network that blackholes it must
// not stall a run for the registry's whole fetch-timeout.
const DEPS_DEV_TIMEOUT_MS = 5000

type Fetched =
  | { ok: true; body: unknown }
  | { ok: false; status?: number; message: string; skipped?: true }

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'status' in error &&
  typeof error.status === 'number'
    ? error.status
    : undefined

/**
 * Latest, versions, deprecation and publish times per package. A public npm
 * name takes dist-tags plus deps.dev (two small documents) and falls back to
 * the abbreviated packument; any other name takes one packument request.
 * One lookup per name per reader; at most `maxSockets` requests in flight.
 */
export const createRegistryReader = ({
  registryConfig,
  client,
  depsDev,
  endpoints = DEFAULT_ENDPOINTS,
}: RegistryReaderOptions): RegistryReader => {
  const limit = createLimiter(registryConfig.maxSockets)
  const cache = new Map<string, Promise<PackageLookup>>()
  let depsDevUsable = depsDev

  const get = (
    url: string,
    base: string,
    accept: string,
    extra: { timeout?: number; retries?: number; skipIf?: () => boolean } = {},
  ): Promise<Fetched> =>
    limit(async (): Promise<Fetched> => {
      // Checked once the slot is ours: the world may have changed while queued.
      if (extra.skipIf?.())
        return { ok: false, message: 'skipped', skipped: true }
      try {
        const body = await client.getJson(url, base, {
          accept,
          timeout: extra.timeout,
          retries: extra.retries,
        })
        return { ok: true, body }
      } catch (error) {
        return { ok: false, status: statusOf(error), message: messageOf(error) }
      }
    })

  const fail = (
    name: string,
    kind: 'not-found' | 'request' | 'invalid',
    reason: string,
  ): PackageLookup => ({ ok: false, name, kind, reason })

  const found = (
    name: string,
    latest: string,
    versions: RegistryVersion[],
    source: RegistryPackage['source'],
  ): PackageLookup => ({
    ok: true,
    package: { name, latest, versions, source },
  })

  const depsDevVersions = async (
    name: string,
  ): Promise<RegistryVersion[] | undefined> => {
    if (!depsDevUsable) return undefined
    const fetched = await get(
      depsDevUrl(name, endpoints.depsDev),
      endpoints.depsDev,
      'application/json',
      {
        timeout: Math.min(registryConfig.fetchTimeout, DEPS_DEV_TIMEOUT_MS),
        // deps.dev has a fallback, and any 429, 5xx or transport failure trips
        // the breaker anyway, so a retry only delays the fallback.
        retries: 0,
        skipIf: () => !depsDevUsable,
      },
    )
    if (!fetched.ok && fetched.skipped) return undefined
    if (fetched.ok) {
      const versions = parseDepsDevPackage(fetched.body)
      if (!versions)
        logger.debug(`deps.dev sent an unreadable document for ${name}`)
      return versions
    }
    const { status } = fetched
    if (status === 404) {
      logger.debug(`${name} is not on deps.dev`)
    } else if (status === undefined || status === 429 || status >= 500) {
      depsDevUsable = false
      logger.debug(
        `deps.dev unavailable (${fetched.message}); reading packuments for the rest of the run`,
      )
    } else {
      logger.debug(`deps.dev answered ${status} for ${name}`)
    }
    return undefined
  }

  const packumentLookup = async (
    name: string,
    registry: string,
    expectedLatest?: string,
  ): Promise<PackageLookup> => {
    const url = packumentUrl(name, registry)
    const host = new URL(registry).host
    let fetched = await get(url, registry, ABBREVIATED_ACCEPT)
    // pacote asks again for the full document when the abbreviated one is 404.
    if (!fetched.ok && fetched.status === 404) {
      fetched = await get(url, registry, 'application/json')
    }
    if (!fetched.ok) {
      return fetched.status === 404
        ? fail(name, 'not-found', `${name} is not in ${host}`)
        : fail(name, 'request', fetched.message)
    }
    const packument = parsePackument(fetched.body)
    if (!packument) {
      return fail(
        name,
        'invalid',
        `${host} sent an unreadable document for ${name}`,
      )
    }
    const { versions } = packument
    if (versions.length === 0) {
      return fail(name, 'not-found', `${name} has no published versions`)
    }
    const listed = (version: string | undefined): version is string =>
      version !== undefined && versions.some((v) => v.version === version)
    const stable = versions.filter((v) => semver.prerelease(v.version) === null)
    const latest = listed(expectedLatest)
      ? expectedLatest
      : listed(packument.latest)
        ? packument.latest
        : (stable.at(-1) ?? versions[versions.length - 1])?.version
    if (latest === undefined) {
      return fail(name, 'not-found', `${name} has no published versions`)
    }
    return found(name, latest, versions, 'packument')
  }

  const publicLookup = async (
    name: string,
    registry: string,
  ): Promise<PackageLookup> => {
    const [tags, versions] = await Promise.all([
      get(distTagsUrl(name, registry), registry, 'application/json'),
      depsDevVersions(name),
    ])
    if (!tags.ok && tags.status === 404) {
      return fail(
        name,
        'not-found',
        `${name} is not in ${new URL(registry).host}`,
      )
    }
    const latest = tags.ok ? parseDistTags(tags.body) : undefined
    if (latest === undefined) {
      logger.debug(`No dist-tags latest for ${name}; reading its packument`)
      return packumentLookup(name, registry)
    }
    if (versions?.some((v) => v.version === latest)) {
      return found(name, latest, versions, 'deps.dev')
    }
    logger.debug(
      versions
        ? `deps.dev does not list ${name}@${latest}; reading its packument`
        : `No deps.dev versions for ${name}; reading its packument`,
    )
    return packumentLookup(name, registry, latest)
  }

  const read = (name: string): Promise<PackageLookup> => {
    if (!isValidPackageName(name)) {
      return Promise.resolve(
        fail(
          name,
          'invalid',
          `${JSON.stringify(name)} is not a valid package name`,
        ),
      )
    }
    const registry = registryFor(name, registryConfig)
    return depsDevUsable &&
      isPublicNpmRegistry(registry, endpoints.publicRegistries)
      ? publicLookup(name, registry)
      : packumentLookup(name, registry)
  }

  return {
    lookup: (name) => {
      let request = cache.get(name)
      if (!request) {
        request = read(name)
        cache.set(name, request)
      }
      return request
    },
  }
}
