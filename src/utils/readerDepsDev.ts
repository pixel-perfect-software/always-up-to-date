import type { RegistryVersion } from '@/types'
import logger from './logger'
import type { Failed, ReaderContext } from './readerContext'
import type { CachedEntry } from './registryCache'
import { parseDepsDevPackage } from './registryDocuments'
import { depsDevUrl } from './registryRequest'

// deps.dev is an accelerator with a fallback: a network that blackholes it must
// not stall a run for the registry's whole fetch-timeout.
export const DEPS_DEV_TIMEOUT_MS = 5000

// A 429 or a timeout turns deps.dev off at once (overload, or a blackholed
// network). Any other 5xx or transport failure falls back for that package
// alone; this many of them in a run turn it off too.
const DEPS_DEV_FAILURE_LIMIT = 3

export interface DepsDev {
  /** False once the breaker has tripped, or when the run never asks deps.dev. */
  usable(): boolean
  /**
   * The versions deps.dev lists for `name`, revalidating `hit`; undefined
   * when it is off, failed or sent an unreadable document.
   */
  versions(
    name: string,
    hit?: CachedEntry<'deps.dev'>,
  ): Promise<RegistryVersion[] | undefined>
}

/** deps.dev's versions behind a breaker that turns it off for the rest of the run. */
export const createDepsDev = (
  { registryConfig, endpoints, cache, revalidate }: ReaderContext,
  { enabled, timeout }: { enabled: boolean; timeout: number },
): DepsDev => {
  let usable = enabled
  let failures = 0

  // Decided in the request's slot: the queued request behind it must see a
  // tripped breaker, not race the caller's continuation.
  const judge = (name: string, failure: Failed): void => {
    const { status } = failure
    if (status === 404) {
      logger.debug(`${name} is not on deps.dev`)
    } else if (status === 429 || failure.code === 'ETIMEDOUT') {
      usable = false
      logger.debug(
        `deps.dev unavailable (${failure.message}); reading packuments for the rest of the run`,
      )
    } else if (status === undefined || status >= 500) {
      failures++
      if (failures >= DEPS_DEV_FAILURE_LIMIT) {
        usable = false
        logger.debug(
          `deps.dev unavailable (${failure.message}; ${failures} failures); reading packuments for the rest of the run`,
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

  const versions = async (
    name: string,
    hit?: CachedEntry<'deps.dev'>,
  ): Promise<RegistryVersion[] | undefined> => {
    if (!usable) return undefined
    const fetched = await revalidate(
      depsDevUrl(name, endpoints.depsDev),
      endpoints.depsDev,
      'application/json',
      hit,
      parseDepsDevPackage,
      {
        timeout: Math.min(registryConfig.fetchTimeout, timeout),
        // The fallback is the retry; retries would multiply the timeout.
        retries: 0,
        skipIf: () => !usable,
        onFailure: (failure) => judge(name, failure),
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

  return { usable: () => usable, versions }
}
