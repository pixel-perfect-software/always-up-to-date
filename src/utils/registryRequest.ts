const RETRY_BASE_MS = 100
export const RETRY_MAX_MS = 1000
// A throttled registry is abnormal, so a server's own `Retry-After` is waited
// for up to this long. Past it we stop retrying: a skipped lookup lets the
// update through without its cooldown check, which beats stalling the run.
export const RETRY_AFTER_MAX_MS = 10_000

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'])

export const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 420 || status === 429 || status >= 500

/**
 * What a run says when a host throttled it, naming each host and its count, or
 * undefined when none did. The lookups fall back and the results stay correct,
 * so only the time would show it (#174). `pnpm run bench` finds this line in
 * what autd prints (`throttledLines`, `bench/report.ts`).
 */
export const throttledNotice = (
  hosts: Record<string, { throttled: number }>,
): string | undefined => {
  const named = Object.entries(hosts)
    .filter(([, { throttled }]) => throttled > 0)
    .map(
      ([host, { throttled }]) =>
        `${host} (${throttled} ${throttled === 1 ? 'request' : 'requests'})`,
    )
  return named.length > 0
    ? `Throttled by ${named.join(', ')}, so this run was slower than usual`
    : undefined
}

export const isRetryableError = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string' &&
  RETRYABLE_CODES.has(error.code)

/**
 * Milliseconds to wait before retry `attempt` (0-based), or undefined to stop:
 * a `Retry-After` over `RETRY_AFTER_MAX_MS` is not waited for and not cut
 * short. Without the header, backoff doubles from 100 ms up to `RETRY_MAX_MS`.
 */
export const retryDelay = (
  attempt: number,
  retryAfter: string | undefined,
  now: number,
): number | undefined => {
  const header = retryAfter?.trim()
  if (header) {
    let ms: number | undefined
    if (/^\d+$/.test(header)) ms = Number(header) * 1000
    else {
      const date = Date.parse(header)
      if (!Number.isNaN(date)) ms = Math.max(0, date - now)
    }
    if (ms !== undefined) return ms <= RETRY_AFTER_MAX_MS ? ms : undefined
  }
  return Math.min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)
}

interface CacheDirectives {
  /** Seconds; the smallest `max-age` when the header repeats it. */
  maxAge?: number
  noStore: boolean
  noCache: boolean
  isPublic: boolean
  isPrivate: boolean
}

/**
 * The directives of a `Cache-Control` header that autd acts on. Names are
 * case-insensitive; `max-age` is a non-negative integer, quoted or not, and
 * anything else is ignored.
 */
export const parseCacheControl = (
  header: string | undefined,
): CacheDirectives => {
  const directives: CacheDirectives = {
    noStore: false,
    noCache: false,
    isPublic: false,
    isPrivate: false,
  }
  for (const part of (header ?? '').split(',')) {
    const [rawName = '', ...rest] = part.split('=')
    const name = rawName.trim().toLowerCase()
    if (name === 'no-store') directives.noStore = true
    else if (name === 'no-cache') directives.noCache = true
    else if (name === 'public') directives.isPublic = true
    else if (name === 'private') directives.isPrivate = true
    else if (name === 'max-age') {
      const value = rest
        .join('=')
        .trim()
        .replace(/^"(.*)"$/, '$1')
      if (/^\d+$/.test(value)) {
        const seconds = Number(value)
        directives.maxAge = Math.min(directives.maxAge ?? seconds, seconds)
      }
    }
  }
  return directives
}

/**
 * Whether a stored answer may be reused only once the registry confirms it (a
 * 304): it was fetched with credentials and isn't known to be the same for
 * everyone, or the registry said `private`, `no-cache` or `max-age=0`.
 */
export const revalidatesEveryUse = (
  meta: { authenticated?: boolean; cacheControl?: string },
  sameForEveryone = false,
): boolean => {
  const directives = parseCacheControl(meta.cacheControl)
  return (
    directives.isPrivate ||
    (meta.authenticated === true && !sameForEveryone) ||
    directives.noCache ||
    directives.maxAge === 0
  )
}
