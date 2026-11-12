import semver from 'semver'
import type { PackageLookup, ReleaseWindow } from '@/types'
import logger from './logger'
import { messageOf, type ReaderContext, timesOf } from './readerContext'
import { parsePackument } from './registryDocuments'
import {
  packumentUrl,
  registryFor,
  revalidatesEveryUse,
} from './registryRequest'

/** The first three of `versions`, then how many more. */
const sample = (versions: readonly string[]): string =>
  versions.length <= 3
    ? versions.join(', ')
    : `${versions.slice(0, 3).join(', ')} and ${versions.length - 3} more`

/**
 * Publish times by version: the lookup's own, plus the full packument's for
 * the versions a cooldown judges that the lookup has none for. One full
 * packument per name per reader.
 */
export const createReleaseTimes = (
  { registryConfig, cache, counts, revalidate }: ReaderContext,
  lookup: (name: string) => Promise<PackageLookup>,
): ((
  name: string,
  window?: ReleaseWindow,
) => Promise<Record<string, string>>) => {
  // A name's full packument is asked for once per run: the lookup is
  // memoized, so the versions it lacks a time for are the same on every call.
  const fullRequests = new Map<string, Promise<Record<string, string>>>()

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

  return async (
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
}
