import type { RegistryConfig, RegistryVersion } from '@/types'
import { codeOf, messageOf, statusOf } from './errorFields'
import { createLimiter } from './limiter'
import type { RegistryCache, ResponseMeta } from './registryCache'
import type { RegistryClient, RegistryResponse } from './registryClient'
import { describeUrl, type RegistryEndpoints } from './registryRequest'

export type Failed = {
  ok: false
  status?: number
  code?: string
  message: string
  skipped?: true
}

export type Fetched = { ok: true; response: RegistryResponse } | Failed

/** A parsed answer, from a body or (after a 304) from the entry that was revalidated. */
export type Revalidated<V> =
  | { ok: true; value: V | undefined; meta: ResponseMeta; notModified: boolean }
  | Failed

export interface GetOptions {
  timeout?: number
  retries?: number
  skipIf?: () => boolean
  /** Runs in the slot, so the next queued task sees what it decided. */
  onFailure?: (failure: Failed) => void
  ifNoneMatch?: string
}

/** A stored entry `revalidate` can send the ETag of and answer a 304 with. */
export type RevalidatedEntry<V> = {
  value: V
  etag?: string
  cacheControl?: string
  authenticated?: boolean
}

/**
 * What the reader's parts share for one run: the registry settings, the
 * per-host limiters, the cache and its counts, and the two ways to ask.
 */
export interface ReaderContext {
  registryConfig: RegistryConfig
  endpoints: RegistryEndpoints
  cache?: RegistryCache
  counts: { notModified: number; fetched: number; covered: number }
  get(
    url: string,
    base: string,
    accept: string,
    extra?: GetOptions,
  ): Promise<Fetched>
  revalidate<V>(
    url: string,
    base: string,
    accept: string,
    hit: RevalidatedEntry<V> | undefined,
    parse: (body: unknown) => V | undefined,
    extra?: GetOptions,
  ): Promise<Revalidated<V>>
}

/** The publish times of the versions a document lists, and only those. */
export const timesOf = (
  versions: readonly RegistryVersion[],
): Record<string, string> => {
  const times: Record<string, string> = {}
  for (const { version, publishedAt } of versions) {
    if (publishedAt) times[version] = publishedAt
  }
  return times
}

export const createReaderContext = ({
  registryConfig,
  client,
  endpoints,
  cache,
}: {
  registryConfig: RegistryConfig
  client: () => Promise<RegistryClient>
  endpoints: RegistryEndpoints
  cache?: RegistryCache
}): ReaderContext => {
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
  const counts = { notModified: 0, fetched: 0, covered: 0 }

  const get = (
    url: string,
    base: string,
    accept: string,
    extra: GetOptions = {},
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
    hit: RevalidatedEntry<V> | undefined,
    parse: (body: unknown) => V | undefined,
    extra: GetOptions = {},
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

  return { registryConfig, endpoints, cache, counts, get, revalidate }
}
