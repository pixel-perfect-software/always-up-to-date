import semver from 'semver'
import type {
  PackageLookup,
  RegistryConfig,
  RegistryPackage,
  RegistryVersion,
} from '@/types'
import { createLimiter } from './limiter'
import logger from './logger'
import type { CachedEntry, RegistryCache, ResponseMeta } from './registryCache'
import type { RegistryClient, RegistryResponse } from './registryClient'
import {
  type ParsedPackument,
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
  /** Called only when a request is needed, so a run the cache answers never loads the client. */
  client: () => Promise<RegistryClient>
  /** Ask deps.dev about public npm names. */
  depsDev: boolean
  endpoints?: RegistryEndpoints
  /** Answers lookups it holds fresh, and revalidates the rest; none reads or writes nothing. */
  cache?: RegistryCache
}

export interface RegistryReader {
  /** Never rejects for a network, HTTP or parse failure; those are `ok: false`. */
  lookup(name: string): Promise<PackageLookup>
  /** What the registries answered with: 304s (revalidated) and 200 bodies the cache could store. */
  stats(): { notModified: number; fetched: number }
}

// deps.dev is an accelerator with a fallback: a network that blackholes it must
// not stall a run for the registry's whole fetch-timeout.
const DEPS_DEV_TIMEOUT_MS = 5000

// A 429 or a timeout turns deps.dev off at once (overload, or a blackholed
// network). Any other 5xx or transport failure falls back for that package
// alone; this many of them in a run turn it off too.
const DEPS_DEV_FAILURE_LIMIT = 3

type Failed = {
  ok: false
  status?: number
  code?: string
  message: string
  skipped?: true
}

type Fetched = { ok: true; response: RegistryResponse } | Failed

/** A parsed answer, from a body or (after a 304) from the entry that was revalidated. */
const lists = (
  versions: readonly RegistryVersion[],
  version: string | undefined,
): version is string =>
  version !== undefined && versions.some((v) => v.version === version)

type Revalidated<V> =
  | { ok: true; value: V | undefined; meta: ResponseMeta; notModified: boolean }
  | Failed

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const statusOf = (error: unknown): number | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'status' in error &&
  typeof error.status === 'number'
    ? error.status
    : undefined

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : undefined

/**
 * Latest, versions, deprecation and publish times per package. A public npm
 * name takes dist-tags plus deps.dev (two small documents) and falls back to
 * the abbreviated packument; any other name takes one packument request.
 * One lookup per name per reader; at most `maxSockets` requests in flight per host.
 */
export const createRegistryReader = ({
  registryConfig,
  client,
  depsDev,
  endpoints = DEFAULT_ENDPOINTS,
  cache,
}: RegistryReaderOptions): RegistryReader => {
  // One limiter per host, each the client's per-host agent cap, so a queued
  // request never waits in an agent queue and burns its timeout.
  const limiters = new Map<string, ReturnType<typeof createLimiter>>()
  const limiterFor = (url: string) => {
    const host = new URL(url).host
    let limit = limiters.get(host)
    if (!limit) {
      limit = createLimiter(registryConfig.maxSockets)
      limiters.set(host, limit)
    }
    return limit
  }
  const lookups = new Map<string, Promise<PackageLookup>>()
  let depsDevUsable = depsDev
  let depsDevFailures = 0
  const counts = { notModified: 0, fetched: 0 }

  const get = (
    url: string,
    base: string,
    accept: string,
    extra: {
      timeout?: number
      retries?: number
      skipIf?: () => boolean
      /** Runs in the slot, so the next queued task sees what it decided. */
      onFailure?: (failure: Failed) => void
      ifNoneMatch?: string
    } = {},
  ): Promise<Fetched> =>
    limiterFor(url)(async (): Promise<Fetched> => {
      // Checked once the slot is ours: the world may have changed while queued.
      if (extra.skipIf?.())
        return { ok: false, message: 'skipped', skipped: true }
      try {
        const response = await (await client()).getResponse(url, base, {
          accept,
          timeout: extra.timeout,
          retries: extra.retries,
          ifNoneMatch: extra.ifNoneMatch,
        })
        return { ok: true, response }
      } catch (error) {
        const failure: Failed = {
          ok: false,
          status: statusOf(error),
          code: codeOf(error),
          message: messageOf(error),
        }
        extra.onFailure?.(failure)
        return failure
      }
    })

  /**
   * GET, conditional on the stale entry's ETag, and parse. A 304 answers with
   * the entry's value. A failure is a failure whatever the cache holds: no
   * stale fallback.
   */
  const revalidate = async <V>(
    url: string,
    base: string,
    accept: string,
    hit:
      | {
          value: V
          etag?: string
          cacheControl?: string
          authenticated?: boolean
        }
      | undefined,
    parse: (body: unknown) => V | undefined,
    extra: Parameters<typeof get>[3] = {},
  ): Promise<Revalidated<V>> => {
    const fetched = await get(url, base, accept, {
      ...extra,
      ifNoneMatch: hit?.etag,
    })
    if (!fetched.ok) return fetched
    const { response } = fetched
    if (response.notModified) {
      if (!hit) {
        return { ok: false, message: `${url} answered 304 to a plain request` }
      }
      counts.notModified++
      // RFC 9111 §4.3.4: what the 304 restates replaces what was stored. A
      // 304 that is silent about Cache-Control keeps the stored one, so a
      // no-cache or short-lived entry does not turn into a default-TTL one.
      const meta: ResponseMeta = {
        authenticated: response.authenticated || hit.authenticated === true,
        cacheControl: response.cacheControl ?? hit.cacheControl,
        etag: response.etag ?? hit.etag,
        age: response.age,
      }
      return { ok: true, value: hit.value, meta, notModified: true }
    }
    const meta: ResponseMeta = {
      authenticated: response.authenticated,
      cacheControl: response.cacheControl,
      etag: response.etag,
      age: response.age,
    }
    counts.fetched++
    return { ok: true, value: parse(response.body), meta, notModified: false }
  }

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

  // Decided in the request's slot: the queued request behind it must see a
  // tripped breaker, not race the caller's continuation.
  const judgeDepsDev = (name: string, failure: Failed): void => {
    const { status } = failure
    if (status === 404) {
      logger.debug(`${name} is not on deps.dev`)
    } else if (status === 429 || failure.code === 'ETIMEDOUT') {
      depsDevUsable = false
      logger.debug(
        `deps.dev unavailable (${failure.message}); reading packuments for the rest of the run`,
      )
    } else if (status === undefined || status >= 500) {
      depsDevFailures++
      if (depsDevFailures >= DEPS_DEV_FAILURE_LIMIT) {
        depsDevUsable = false
        logger.debug(
          `deps.dev unavailable (${failure.message}; ${depsDevFailures} failures); reading packuments for the rest of the run`,
        )
      } else {
        logger.debug(
          `deps.dev failed for ${name} (${failure.message}); reading its packument`,
        )
      }
    } else {
      logger.debug(`deps.dev answered ${status} for ${name}`)
    }
  }

  const depsDevVersions = async (
    name: string,
    hit?: CachedEntry<'deps.dev'>,
  ): Promise<RegistryVersion[] | undefined> => {
    if (!depsDevUsable) return undefined
    const fetched = await revalidate(
      depsDevUrl(name, endpoints.depsDev),
      endpoints.depsDev,
      'application/json',
      hit,
      parseDepsDevPackage,
      {
        timeout: Math.min(registryConfig.fetchTimeout, DEPS_DEV_TIMEOUT_MS),
        // The fallback is the retry; retries would multiply the timeout.
        retries: 0,
        skipIf: () => !depsDevUsable,
        onFailure: (failure) => judgeDepsDev(name, failure),
      },
    )
    if (!fetched.ok) return undefined
    if (!fetched.value) {
      logger.debug(`deps.dev sent an unreadable document for ${name}`)
      return undefined
    }
    cache?.put('deps.dev', endpoints.depsDev, name, fetched.value, fetched.meta)
    return fetched.value
  }

  const packumentLookup = async (
    name: string,
    registry: string,
    expectedLatest?: string,
  ): Promise<PackageLookup> => {
    const url = packumentUrl(name, registry)
    const host = new URL(registry).host
    // A fresh entry that lacks the latest dist-tags named is revalidated, not trusted.
    const usable = (
      hit: { fresh: boolean; value: ParsedPackument } | undefined,
    ) =>
      hit?.fresh &&
      (expectedLatest === undefined ||
        lists(hit.value.versions, expectedLatest))
    const abbreviatedHit = cache?.get('packument', registry, name)
    let fullHit: CachedEntry<'packument-full'> | undefined
    let fullRead = false
    const readFull = () => {
      if (!fullRead) {
        fullRead = true
        fullHit = cache?.get('packument-full', registry, name)
      }
      return fullHit
    }

    let packument: ParsedPackument | undefined
    let failure: Failed | undefined
    if (abbreviatedHit && usable(abbreviatedHit)) {
      packument = abbreviatedHit.value
    } else if (!abbreviatedHit && usable(readFull())) {
      // A registry that serves only the full document never has an abbreviated entry.
      packument = fullHit?.value
    } else {
      let fetched = await revalidate(
        url,
        registry,
        ABBREVIATED_ACCEPT,
        abbreviatedHit,
        parsePackument,
      )
      let kind: 'packument' | 'packument-full' = 'packument'
      // pacote asks again for the full document when the abbreviated one is 404.
      if (!fetched.ok && fetched.status === 404) {
        kind = 'packument-full'
        const hit = readFull()
        if (usable(hit)) {
          packument = hit?.value
        } else {
          fetched = await revalidate(
            url,
            registry,
            'application/json',
            hit,
            parsePackument,
          )
        }
      }
      if (!packument) {
        if (!fetched.ok) {
          failure = fetched
        } else if (fetched.value) {
          packument = fetched.value
          cache?.put(kind, registry, name, fetched.value, fetched.meta)
        } else {
          return fail(
            name,
            'invalid',
            `${host} sent an unreadable document for ${name}`,
          )
        }
      }
    }
    if (failure) {
      return failure.status === 404
        ? fail(name, 'not-found', `${name} is not in ${host}`)
        : fail(name, 'request', failure.message)
    }
    if (!packument) return fail(name, 'request', `no answer for ${name}`)
    const { versions } = packument
    if (versions.length === 0) {
      return fail(name, 'not-found', `${name} has no published versions`)
    }
    const stable = versions.filter((v) => semver.prerelease(v.version) === null)
    const latest = lists(versions, expectedLatest)
      ? expectedLatest
      : lists(versions, packument.latest)
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
    depsDevHit: CachedEntry<'deps.dev'> | undefined,
  ): Promise<PackageLookup> => {
    const tagsHit = cache?.get('dist-tags', registry, name)
    const [fetchedTags, firstVersions] = await Promise.all([
      tagsHit?.fresh
        ? undefined
        : revalidate(
            distTagsUrl(name, registry),
            registry,
            'application/json',
            tagsHit,
            (body) => {
              const latest = parseDistTags(body)
              return latest === undefined ? undefined : { latest }
            },
          ),
      depsDevHit?.fresh
        ? Promise.resolve(depsDevHit.value)
        : depsDevVersions(name, depsDevHit),
    ])
    if (fetchedTags && !fetchedTags.ok && fetchedTags.status === 404) {
      return fail(
        name,
        'not-found',
        `${name} is not in ${new URL(registry).host}`,
      )
    }
    let latest: string | undefined
    if (fetchedTags === undefined) {
      latest = tagsHit?.value.latest
    } else if (fetchedTags.ok && fetchedTags.value) {
      latest = fetchedTags.value.latest
      // deps.dev indexes only public packages: if it lists the name, its
      // dist-tags are the same for everyone, whoever asked.
      cache?.put(
        'dist-tags',
        registry,
        name,
        fetchedTags.value,
        fetchedTags.meta,
        {
          sameForEveryone: firstVersions !== undefined,
        },
      )
    }
    if (latest === undefined) {
      logger.debug(`No dist-tags latest for ${name}; reading its packument`)
      return packumentLookup(name, registry)
    }
    let versions = firstVersions
    // A fresh deps.dev entry can be older than the release dist-tags names:
    // ask deps.dev once more before reading a whole packument.
    if (depsDevHit?.fresh && versions && !lists(versions, latest)) {
      versions = await depsDevVersions(name)
    }
    if (versions && lists(versions, latest)) {
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
    if (!depsDev || !isPublicNpmRegistry(registry, endpoints.publicRegistries))
      return packumentLookup(name, registry)
    // A tripped breaker still lets a fresh deps.dev entry answer.
    const depsDevHit = cache?.get('deps.dev', endpoints.depsDev, name)
    return depsDevUsable || depsDevHit?.fresh
      ? publicLookup(name, registry, depsDevHit)
      : packumentLookup(name, registry)
  }

  return {
    lookup: (name) => {
      let request = lookups.get(name)
      if (!request) {
        request = read(name)
        lookups.set(name, request)
      }
      return request
    },
    stats: () => ({ ...counts }),
  }
}
