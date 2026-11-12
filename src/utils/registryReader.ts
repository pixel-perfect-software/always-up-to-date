import type {
  PackageLookup,
  RegistryConfig,
  ReleaseWindow,
  VersionManifest,
} from '@/types'
import { createReaderContext } from './readerContext'
import { createDepsDev, DEPS_DEV_TIMEOUT_MS } from './readerDepsDev'
import { createLookup } from './readerLookup'
import { createVersionManifest } from './readerManifests'
import { createReleaseTimes } from './readerReleaseTimes'
import type { RegistryCache } from './registryCache'
import type { RegistryClient } from './registryClient'
import { DEFAULT_ENDPOINTS, type RegistryEndpoints } from './registryUrls'

interface RegistryReaderOptions {
  registryConfig: RegistryConfig
  /** Called only when a request is needed, so a run the cache answers never loads the client. */
  client: () => Promise<RegistryClient>
  /** Ask deps.dev about public npm names. */
  depsDev: boolean
  endpoints?: RegistryEndpoints
  /** Answers lookups it holds fresh, and revalidates the rest; none reads or writes nothing. */
  cache?: RegistryCache
  /** Longest a deps.dev request may take, capped by `fetch-timeout`; a test seam. */
  depsDevTimeout?: number
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

/**
 * Latest, versions, deprecation and publish times per package. A public npm
 * name takes dist-tags plus deps.dev (two small documents) and falls back to
 * the abbreviated packument; any other name takes one packument request.
 * `releaseTimes` adds the full packument's times for the versions a cooldown
 * judges that the lookup has none for. One lookup and one full packument per
 * name per reader; at most `maxSockets` requests in flight per host.
 *
 * The parts share one context (`readerContext.ts`): the per-host limiters,
 * the cache and its counts, and the client. The deps.dev breaker
 * (`readerDepsDev.ts`) serves the lookup (`readerLookup.ts`), which
 * `releaseTimes` (`readerReleaseTimes.ts`) and `versionManifest`
 * (`readerManifests.ts`) build on.
 */
export const createRegistryReader = ({
  registryConfig,
  client,
  depsDev,
  endpoints = DEFAULT_ENDPOINTS,
  cache,
  depsDevTimeout = DEPS_DEV_TIMEOUT_MS,
}: RegistryReaderOptions): RegistryReader => {
  const context = createReaderContext({
    registryConfig,
    client,
    endpoints,
    cache,
  })
  const breaker = createDepsDev(context, {
    enabled: depsDev,
    timeout: depsDevTimeout,
  })
  const lookup = createLookup(context, breaker, { enabled: depsDev })
  return {
    lookup,
    releaseTimes: createReleaseTimes(context, lookup),
    versionManifest: createVersionManifest(context, lookup),
    stats: () => ({ ...context.counts }),
  }
}
