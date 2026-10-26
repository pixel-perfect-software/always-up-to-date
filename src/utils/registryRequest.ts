import type { RegistryConfig, RegistryCredentials } from '@/types'

export const RETRY_BASE_MS = 100
export const RETRY_MAX_MS = 1000
// A throttled registry is abnormal, so a server's own `Retry-After` is waited
// for up to this long. Past it we stop retrying: a skipped lookup lets the
// update through without its cooldown check, which beats stalling the run.
export const RETRY_AFTER_MAX_MS = 10_000

const RETRYABLE_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT'])

/** The registry a package is fetched from: its scope's, else the default. */
export const registryFor = (name: string, config: RegistryConfig): string => {
  if (name.startsWith('@')) {
    const scoped = config.scopedRegistries[name.slice(0, name.indexOf('/'))]
    if (scoped) return scoped
  }
  return config.registry
}

/** `<registry>/<name>`, with the scope's slash escaped as npm does. */
export const packumentUrl = (name: string, registry: string): string =>
  `${registry.trim().replace(/\/?$/, '')}/${name.replace('/', '%2f')}`

/**
 * The `//host[:port]/path/` prefixes .npmrc could scope credentials to for a
 * URL, longest first, ending at `//host/`.
 */
export const credentialPrefixes = (url: URL): string[] => {
  const prefixes: string[] = []
  let prefix = `//${url.host}${url.pathname}`
  while (prefix.length > 2) {
    prefixes.push(prefix)
    prefix = prefix.replace(/([^/]+|\/)$/, '')
  }
  return prefixes
}

/**
 * The `//host[:port]/path/` key .npmrc files scope a registry's credentials
 * to: no protocol, no userinfo, always a trailing slash.
 */
export const nerfDart = (registry: string): string => {
  const url = new URL(registry)
  return `//${url.host}${url.pathname.replace(/\/?$/, '/')}`
}

const holdsCredential = (c: RegistryCredentials): boolean =>
  Boolean(
    c.authToken ||
      c.auth ||
      (c.username && c.password) ||
      (c.certfile && c.keyfile),
  )

const lookUp = (
  url: URL,
  credentials: Record<string, RegistryCredentials>,
): RegistryCredentials | undefined => {
  for (const prefix of credentialPrefixes(url)) {
    const found = credentials[prefix]
    if (found && holdsCredential(found)) return found
  }
  return undefined
}

/**
 * The credentials .npmrc scopes to a URL: the longest matching prefix, every
 * field from that prefix only. A URL on the registry's own host that has none
 * of its own falls back to the registry's, as npm does for tarball URLs.
 */
export const credentialsFor = (
  url: URL,
  registry: string,
  credentials: Record<string, RegistryCredentials>,
): RegistryCredentials | undefined => {
  const direct = lookUp(url, credentials)
  if (direct) return direct
  const base = new URL(registry)
  if (base.host === url.host && base.href !== url.href) {
    return lookUp(base, credentials)
  }
  return undefined
}

export const authorizationFor = (
  c: RegistryCredentials | undefined,
): string | undefined => {
  if (!c) return undefined
  if (c.authToken) return `Bearer ${c.authToken}`
  if (c.auth) return `Basic ${c.auth}`
  if (c.username && c.password) {
    const password = Buffer.from(c.password, 'base64').toString('utf8')
    return `Basic ${Buffer.from(`${c.username}:${password}`).toString('base64')}`
  }
  return undefined
}

export const isRetryableStatus = (status: number): boolean =>
  status === 408 || status === 420 || status === 429 || status >= 500

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

/** Sent for packuments: npm's install-time document, which omits most fields. */
export const ABBREVIATED_ACCEPT =
  'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'

export interface RegistryEndpoints {
  /** Origins whose package names the reader may send to deps.dev. */
  publicRegistries: readonly string[]
  /** The deps.dev package URL prefix. */
  depsDev: string
}

export const DEFAULT_ENDPOINTS: RegistryEndpoints = {
  publicRegistries: [
    'https://registry.npmjs.org',
    'https://registry.yarnpkg.com',
  ],
  depsDev: 'https://api.deps.dev/v3/systems/npm/packages/',
}

/** Whether a registry URL is the root of one of the public registries. */
export const isPublicNpmRegistry = (
  registry: string,
  origins: readonly string[],
): boolean => {
  try {
    const url = new URL(registry.trim())
    return origins.includes(url.origin) && url.pathname === '/'
  } catch {
    return false
  }
}

/** `<registry>/-/package/<name>/dist-tags`, with the scope's slash escaped. */
export const distTagsUrl = (name: string, registry: string): string =>
  `${registry.trim().replace(/\/?$/, '')}/-/package/${name.replace('/', '%2f')}/dist-tags`

/** deps.dev's URL for a package: the whole name escaped, `@types/ms` → `%40types%2Fms`. */
export const depsDevUrl = (name: string, base: string): string =>
  base + encodeURIComponent(name)

const MAX_NAME_LENGTH = 214

/**
 * Whether a name is safe to put in a URL path: unscoped, or `@scope/pkg`,
 * each part non-empty, not `.` or `..`, and unchanged by escaping. Legacy
 * uppercase names pass.
 */
export const isValidPackageName = (name: string): boolean => {
  if (name.length === 0 || name.length > MAX_NAME_LENGTH) return false
  let parts = [name]
  if (name.startsWith('@')) {
    const slash = name.indexOf('/')
    if (slash === -1) return false
    parts = [name.slice(1, slash), name.slice(slash + 1)]
  }
  return parts.every(
    (part) =>
      part.length > 0 &&
      part !== '.' &&
      part !== '..' &&
      encodeURIComponent(part) === part,
  )
}
