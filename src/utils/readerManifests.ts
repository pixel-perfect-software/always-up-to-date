import semver from 'semver'
import type { PackageLookup, VersionManifest } from '@/types'
import { messageOf } from './errorFields'
import logger from './logger'
import type { ReaderContext } from './readerContext'
import { parseVersionManifest } from './registryDocuments'
import { revalidatesEveryUse } from './registryRequest'
import {
  isValidPackageName,
  registryFor,
  versionManifestUrl,
} from './registryUrls'

/**
 * One version's own manifest (#196), memoized per name and version per
 * reader, failures included, and never rejecting.
 */
export const createVersionManifest = (
  { registryConfig, cache, counts, revalidate }: ReaderContext,
  lookup: (name: string) => Promise<PackageLookup>,
): ((
  name: string,
  version: string,
) => Promise<VersionManifest | undefined>) => {
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
  return (
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
}
