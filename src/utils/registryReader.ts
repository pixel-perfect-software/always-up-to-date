import semver from 'semver'
import type {
  PackageLookup,
  RegistryConfig,
  RegistryPackage,
  RegistryVersion,
  ReleaseWindow,
  VersionManifest,
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
  parseVersionManifest,
} from './registryDocuments'
import {
  ABBREVIATED_ACCEPT,
  DEFAULT_ENDPOINTS,
  depsDevUrl,
  describeUrl,
  distTagsUrl,
  isPublicNpmRegistry,
  isValidPackageName,
  packumentUrl,
  type RegistryEndpoints,
  registryFor,
  revalidatesEveryUse,
  versionManifestUrl,
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
  /**
   * Publish times by version: the lookup's own, plus the full packument's when
   * a version in `window` (any version, without one) has none. The full
   * packument's time wins where both have one, and only versions both it and
   * the lookup list count. Never rejects: a failed request leaves the lookup's
   * times, with a debug line. A name whose lookup failed is `{}`, with no
   * request.
   */
  releaseTimes(
    name: string,
    window?: ReleaseWindow,
  ): Promise<Record<string, string>>
  /**
   * One version's own manifest (#196): license, engines, peers. Asked only for
   * a version the name's lookup lists, once per name and version per reader,
   * failures included. Never rejects: a failed, missing or unreadable document
   * is undefined, with a debug line. Its deprecation is the lookup's.
   */
  versionManifest(
    name: string,
    version: string,
  ): Promise<VersionManifest | undefined>
  /**
   * What the registries answered with: 304s (revalidated) and 200 bodies the
   * cache could store. `covered` asked nobody: a stored full packument past its
   * TTL that listed every version `releaseTimes` needed, or a stored version
   * manifest past its TTL.
   */
  stats(): { notModified: number; fetched: number; covered: number }
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

/**
 * `versions` with deps.dev's publish time on each that has none. A new list:
 * the input can be a cached or memoized object other lookups share.
 */
const withTimes = (
  versions: RegistryVersion[],
  listed: readonly RegistryVersion[] | undefined,
): RegistryVersion[] => {
  if (!listed) return versions
  const times = timesOf(listed)
  return versions.map((entry) => {
    const publishedAt = times[entry.version]
    return entry.publishedAt === undefined && publishedAt !== undefined
      ? { ...entry, publishedAt }
      : entry
  })
}

/** The publish times of the versions a document lists, and only those. */
const timesOf = (
  versions: readonly RegistryVersion[],
): Record<string, string> => {
  const times: Record<string, string> = {}
  for (const { version, publishedAt } of versions) {
    if (publishedAt) times[version] = publishedAt
  }
  return times
}

/** The first three of `versions`, then how many more. */
const sample = (versions: readonly string[]): string =>
  versions.length <= 3
    ? versions.join(', ')
    : `${versions.slice(0, 3).join(', ')} and ${versions.length - 3} more`

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
 * `releaseTimes` adds the full packument's times for the versions a cooldown
 * judges that the lookup has none for. One lookup and one full packument per
 * name per reader; at most `maxSockets` requests in flight per host.
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
  // A name's full packument is asked for once per run: the lookup is
  // memoized, so the versions it lacks a time for are the same on every call.
  const fullRequests = new Map<string, Promise<Record<string, string>>>()
  let depsDevUsable = depsDev
  let depsDevFailures = 0
  const counts = { notModified: 0, fetched: 0, covered: 0 }

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
        return {
          ok: false,
          message: `${describeUrl(url, base)} answered 304 to a plain request`,
        }
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
    modified?: string,
  ): PackageLookup => ({
    ok: true,
    package: {
      name,
      latest,
      versions,
      source,
      ...(modified ? { modified } : {}),
    },
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

  /**
   * `depsDevList` is the deps.dev list the caller holds when this is the
   * fallback from a public name: the packument's version list stays, and each
   * version gets deps.dev's publish time, which an abbreviated packument has none of.
   * `heldEntry` is the abbreviated entry the caller already read, so the cache
   * counts it once.
   */
  const packumentLookup = async (
    name: string,
    registry: string,
    expectedLatest?: string,
    depsDevList?: readonly RegistryVersion[],
    heldEntry?: CachedEntry<'packument'>,
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
    const abbreviatedHit = heldEntry ?? cache?.get('packument', registry, name)
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
    // `modified` is trusted only from the public npm registries; the cache
    // keeps it whatever the registry, so trusting another later needs no bump.
    return found(
      name,
      latest,
      withTimes(versions, depsDevList),
      'packument',
      isPublicNpmRegistry(registry, endpoints.publicRegistries)
        ? packument.modified
        : undefined,
    )
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
      return packumentLookup(name, registry, undefined, firstVersions)
    }
    let versions = firstVersions
    let abbreviatedHit: CachedEntry<'packument'> | undefined
    // A fresh deps.dev entry can be older than the release dist-tags names. A
    // fresh packument that lists it answers with no request, so one lagging
    // package doesn't cost a warm run the client; otherwise ask deps.dev once
    // more before reading a whole packument.
    if (depsDevHit?.fresh && versions && !lists(versions, latest)) {
      abbreviatedHit = cache?.get('packument', registry, name)
      if (
        !abbreviatedHit?.fresh ||
        !lists(abbreviatedHit.value.versions, latest)
      ) {
        versions = await depsDevVersions(name)
      }
    }
    if (versions && lists(versions, latest)) {
      return found(name, latest, versions, 'deps.dev')
    }
    logger.debug(
      versions
        ? `deps.dev does not list ${name}@${latest}; reading its packument`
        : `No deps.dev versions for ${name}; reading its packument`,
    )
    return packumentLookup(
      name,
      registry,
      latest,
      versions ?? firstVersions,
      abbreviatedHit,
    )
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

  const lookup = (name: string): Promise<PackageLookup> => {
    let request = lookups.get(name)
    if (!request) {
      request = read(name)
      lookups.set(name, request)
    }
    return request
  }

  /**
   * Every version's publish time the full packument has, for a package whose
   * lookup lacks `needed`. Publish times never change on npm, so a stored
   * document that lists every version in `needed` answers whatever its age:
   * a version it lists without a time is a known gap (the registry has none),
   * one it does not list means it predates that version, and the registry is
   * asked. What the registry says about reuse still holds: an authenticated
   * entry, and one stored under `private`, `no-cache` or `max-age=0`, is
   * asked again every time (a 304 costs no body), as `freshFor` does. This is
   * the document the lookup's 404 fallback stores, under the same key, so a
   * fresh entry written here can also answer a lookup that has no abbreviated
   * one: it is a superset. `judged` names, in the debug line, the versions that
   * made the caller ask. Failures are a debug line and `{}`.
   */
  const fullTimes = async (
    name: string,
    needed: readonly string[],
    judged: readonly string[],
  ): Promise<Record<string, string>> => {
    const registry = registryFor(name, registryConfig)
    const hit = cache?.get('packument-full', registry, name)
    if (hit && !revalidatesEveryUse(hit)) {
      const listed = new Set(hit.value.versions.map((v) => v.version))
      if (needed.every((version) => listed.has(version))) {
        // Inside its TTL, the cache has already counted this answer as fresh.
        if (!hit.fresh) counts.covered++
        return timesOf(hit.value.versions)
      }
    }
    const fetched = await revalidate(
      packumentUrl(name, registry),
      registry,
      'application/json',
      hit,
      parsePackument,
    )
    if (!fetched.ok) {
      logger.debug(
        `Failed to read the full packument of ${name}: ${fetched.message}`,
      )
      return {}
    }
    // After the response, since only that tells a download from a 304.
    const reason = `${sample(judged)} ${judged.length === 1 ? 'has' : 'have'} none`
    logger.debug(
      fetched.notModified
        ? `Revalidated the full packument of ${name} for publish times (304): ${reason}`
        : `Reading the full packument of ${name} for publish times: ${reason}`,
    )
    if (!fetched.value) {
      logger.debug(
        `${new URL(registry).host} sent an unreadable document for ${name}`,
      )
      return {}
    }
    cache?.put('packument-full', registry, name, fetched.value, fetched.meta)
    return timesOf(fetched.value.versions)
  }

  const releaseTimes = async (
    name: string,
    window?: ReleaseWindow,
  ): Promise<Record<string, string>> => {
    const looked = await lookup(name)
    if (!looked.ok) return {}
    const own = timesOf(looked.package.versions)
    const missing = looked.package.versions
      .filter((v) => v.publishedAt === undefined)
      .map((v) => v.version)
    // A window that is not semver (a row whose version is `missing`) judges everything.
    const judged =
      window && semver.valid(window.current) && semver.valid(window.target)
        ? missing.filter(
            (version) =>
              semver.gt(version, window.current) &&
              semver.lte(version, window.target),
          )
        : missing
    if (judged.length === 0) return own
    let request = fullRequests.get(name)
    if (!request) {
      // An unexpected throw is a failed read too: the lookup's times stand.
      request = fullTimes(name, missing, judged).catch((error: unknown) => {
        logger.debug(
          `Failed to read the full packument of ${name}: ${messageOf(error)}`,
        )
        return {}
      })
      fullRequests.set(name, request)
    }
    const full = await request
    // Only versions the lookup lists: a stored document can predate an unpublish.
    const times = { ...own }
    for (const { version } of looked.package.versions) {
      const time = full[version]
      if (time !== undefined) times[version] = time
    }
    return times
  }

  /**
   * npm never republishes a version, so a stored manifest answers whatever its
   * age, as a full packument covering the versions asked about does. What the
   * registry said about reuse still holds: an authenticated entry, and one
   * stored under `private`, `no-cache` or `max-age=0`, is asked again with its
   * ETag every time (a 304 costs no body); `freshFor` keeps no such answer
   * without an ETag. The lookup's deprecation replaces the document's, which a
   * stored entry can hold stale.
   */
  const readManifest = async (
    name: string,
    version: string,
  ): Promise<VersionManifest | undefined> => {
    if (!isValidPackageName(name) || semver.valid(version) !== version)
      return undefined
    const looked = await lookup(name)
    if (!looked.ok) return undefined
    const listed = looked.package.versions.find((v) => v.version === version)
    if (!listed) return undefined
    const registry = registryFor(name, registryConfig)
    const host = new URL(registry).host
    const key = `${name}@${version}`
    const hit = cache?.get('manifest', registry, key)
    // deps.dev indexes only public packages: if the lookup came from it, the
    // manifest is the same for everyone, whoever asked (Q1, as for dist-tags),
    // so a token on the request doesn't stop it being stored and reused.
    const sameForEveryone = looked.package.source === 'deps.dev'
    let manifest: VersionManifest
    if (hit && !revalidatesEveryUse(hit, sameForEveryone)) {
      // Inside its TTL, the cache has already counted this answer as fresh.
      if (!hit.fresh) counts.covered++
      manifest = hit.value
    } else {
      const fetched = await revalidate(
        versionManifestUrl(name, version, registry),
        registry,
        'application/json',
        hit,
        (body) => parseVersionManifest(body, { name, version }),
      )
      if (!fetched.ok) {
        logger.debug(
          fetched.status === 404
            ? `${key} has no manifest on ${host}`
            : `Failed to read the manifest of ${key}: ${fetched.message}`,
        )
        return undefined
      }
      if (!fetched.value) {
        logger.debug(`${host} sent an unreadable manifest for ${key}`)
        return undefined
      }
      manifest = fetched.value
      cache?.put('manifest', registry, key, manifest, fetched.meta, {
        sameForEveryone,
      })
    }
    const { deprecatedReason: _stored, ...rest } = manifest
    return {
      ...rest,
      deprecated: listed.deprecated,
      ...(listed.deprecatedReason
        ? { deprecatedReason: listed.deprecatedReason }
        : {}),
    }
  }

  const manifests = new Map<string, Promise<VersionManifest | undefined>>()
  const versionManifest = (
    name: string,
    version: string,
  ): Promise<VersionManifest | undefined> => {
    const key = `${name}@${version}`
    let request = manifests.get(key)
    if (!request) {
      request = readManifest(name, version).catch((error: unknown) => {
        logger.debug(
          `Failed to read the manifest of ${key}: ${messageOf(error)}`,
        )
        return undefined
      })
      manifests.set(key, request)
    }
    return request
  }

  return {
    lookup,
    releaseTimes,
    versionManifest,
    stats: () => ({ ...counts }),
  }
}
