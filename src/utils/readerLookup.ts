import semver from 'semver'
import type { PackageLookup, RegistryPackage, RegistryVersion } from '@/types'
import logger from './logger'
import { type Failed, type ReaderContext, timesOf } from './readerContext'
import type { DepsDev } from './readerDepsDev'
import type { CachedEntry } from './registryCache'
import {
  type ParsedPackument,
  parseDistTags,
  parsePackument,
} from './registryDocuments'
import {
  ABBREVIATED_ACCEPT,
  distTagsUrl,
  isPublicNpmRegistry,
  isValidPackageName,
  packumentUrl,
  registryFor,
} from './registryRequest'

/** Whether `versions` lists `version`. */
const lists = (
  versions: readonly RegistryVersion[],
  version: string | undefined,
): version is string =>
  version !== undefined && versions.some((v) => v.version === version)

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

/**
 * The memoized lookup: latest, versions, deprecation and publish times per
 * package. A public npm name takes dist-tags plus deps.dev and falls back to
 * the abbreviated packument; any other name takes one packument request. One
 * lookup per name per reader.
 */
export const createLookup = (
  { registryConfig, endpoints, cache, revalidate }: ReaderContext,
  depsDev: DepsDev,
  { enabled }: { enabled: boolean },
): ((name: string) => Promise<PackageLookup>) => {
  const lookups = new Map<string, Promise<PackageLookup>>()

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
        : depsDev.versions(name, depsDevHit),
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
        versions = await depsDev.versions(name)
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
    if (!enabled || !isPublicNpmRegistry(registry, endpoints.publicRegistries))
      return packumentLookup(name, registry)
    // A tripped breaker still lets a fresh deps.dev entry answer.
    const depsDevHit = cache?.get('deps.dev', endpoints.depsDev, name)
    return depsDev.usable() || depsDevHit?.fresh
      ? publicLookup(name, registry, depsDevHit)
      : packumentLookup(name, registry)
  }

  return (name: string): Promise<PackageLookup> => {
    let request = lookups.get(name)
    if (!request) {
      request = read(name)
      lookups.set(name, request)
    }
    return request
  }
}
