import { createHash } from 'crypto'
import type {
  BerryAuthEntry,
  RegistryConfig,
  RegistryCredentials,
  UnusableRegistry,
  YarnV1Auth,
} from '@/types'

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

/** `decodeURIComponent`, or the value as written when it is not valid percent-encoding. */
export const decodeUri = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
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

/** yarn v1's own default registry (`YARN_REGISTRY`), as yarn spells it. */
export const YARN_V1_REGISTRY = 'https://registry.yarnpkg.com'
/** The registry yarn v1 also takes credentials from for its own (`DEFAULT_REGISTRY`). */
const YARN_V1_NPM_REGISTRY = 'https://registry.npmjs.org/'
/** yarn's `SCOPED_PKG_REGEXP`: a `@scope` segment followed by an escaped or plain `/`. */
const YARN_SCOPED = /(?:^|\/)(@[^/?]+?)(?=%2f|\/)/

/**
 * The keys yarn v1's `getRegistryOption` tries for `option` of `registry`, in
 * its order: the registry with a trailing `/`, then without its `http(s):`,
 * then with a trailing `registry/` dropped, each recursively. There is no walk
 * up the path: `https://host/npm/` never reads `//host/:_authToken`.
 */
export const yarnV1RegistryKeys = (
  registry: string,
  option: string,
): string[] => {
  const keys: string[] = []
  const visit = (value: string): void => {
    const reg = value.endsWith('/') ? value : `${value}/`
    keys.push(`${reg}:${option}`)
    if (/^https?:/i.test(reg)) visit(reg.replace(/^https?:/i, ''))
    if (/registry\/?$/.test(reg)) visit(reg.replace(/registry\/?$/, ''))
  }
  visit(registry)
  return keys
}

/** yarn's `getRegistryOrGlobalOption`: the first set (truthy) registry key, else the bare one. */
const yarnV1Option = (
  auth: YarnV1Auth,
  registry: string,
  option: string,
): string | boolean | undefined => {
  for (const key of yarnV1RegistryKeys(registry, option)) {
    if (auth.options[key]) return auth.options[key]
  }
  return auth.options[option] || undefined
}

/** yarn's `getAuthByRegistry`: Bearer, else `_auth`, else username and password, each field on its own. */
const yarnV1AuthByRegistry = (
  auth: YarnV1Auth,
  registry: string,
): string | undefined => {
  const token = yarnV1Option(auth, registry, '_authToken')
  if (token) return `Bearer ${String(token)}`
  const basic = yarnV1Option(auth, registry, '_auth')
  if (basic) return `Basic ${String(basic)}`
  const username = yarnV1Option(auth, registry, 'username')
  const password = yarnV1Option(auth, registry, '_password')
  if (username && password) {
    const decoded = Buffer.from(String(password), 'base64').toString('utf8')
    return `Basic ${Buffer.from(`${String(username)}:${decoded}`).toString('base64')}`
  }
  return undefined
}

/**
 * The Authorization yarn v1 sends with the first request for `url`, built
 * from `registry`: undefined when `config` has no yarn v1 rule or yarn sends
 * none. Verified on yarn 1.22.22, 2026-11-03, against local registries
 * logging `Authorization` (#126, probes c01-c20):
 * - only to a registry a package routes to (the default or a scope's), so
 *   deps.dev never gets one;
 * - only for a scoped package (yarn's `SCOPED_PKG_REGEXP` on the path after
 *   the registry's) or with `always-auth` for that registry or bare;
 * - looked up by that registry (`yarnV1RegistryKeys`), each field falling back
 *   to its bare key: `_authToken=U` alone authenticates every scoped package,
 *   and `//host/:_authToken` does not reach a registry at `//host/npm/`;
 * - yarn's own default registry also takes `registry.npmjs.org`'s credentials.
 */
export const yarnV1AuthorizationFor = (
  url: URL,
  registry: string,
  config: Pick<RegistryConfig, 'registry' | 'scopedRegistries' | 'yarnV1Auth'>,
): string | undefined => {
  const auth = config.yarnV1Auth
  if (!auth) return undefined
  const isDefault = registry === config.registry
  if (!isDefault && !Object.values(config.scopedRegistries).includes(registry))
    return undefined
  const route =
    isDefault && auth.yarnDefault ? YARN_V1_REGISTRY : registry.trim()
  let path = url.pathname
  try {
    const own = new URL(registry.trim()).pathname.replace(/\/?$/, '/')
    if (path.startsWith(own)) path = path.slice(own.length)
  } catch {
    return undefined
  }
  if (!YARN_SCOPED.test(path) && !yarnV1Option(auth, route, 'always-auth')) {
    return undefined
  }
  const routes =
    route === YARN_V1_REGISTRY ? [route, YARN_V1_NPM_REGISTRY] : [route]
  for (const reg of routes) {
    const found = yarnV1AuthByRegistry(auth, reg)
    if (found) return found
  }
  return undefined
}

/** The path of `url` after `registry`'s own, or undefined when `registry` doesn't parse. */
const pathAfter = (url: URL, registry: string): string | undefined => {
  try {
    const own = new URL(registry.trim()).pathname.replace(/\/?$/, '/')
    return url.pathname.startsWith(own)
      ? url.pathname.slice(own.length)
      : url.pathname
  } catch {
    return undefined
  }
}

const isRoute = (
  registry: string,
  config: Pick<RegistryConfig, 'registry' | 'scopedRegistries'>,
): boolean =>
  registry === config.registry ||
  Object.values(config.scopedRegistries).includes(registry)

/**
 * The Authorization yarn berry sends with the first request for `url`, built
 * from `registry`: undefined when `config` has no berry rule or berry sends
 * none. Verified on yarn 4.18.1, 2026-11-03, against local registries logging
 * `Authorization` (#107, probes r01-r30 in `.claude/plans/lockfile-discovery.md`):
 * - only to a registry a package routes to, so deps.dev never gets one;
 * - the configuration that answers is the scope's when it holds a token or
 *   an ident, else the `npmRegistries` entry for `registry` (one trailing
 *   `/` dropped, then without the protocol; no walk up the path, r28), else
 *   the top level (r04, r07, r24);
 * - a scoped package sends what that configuration holds; an unscoped one
 *   only when that configuration's own `npmAlwaysAuth` is set (r01, r02,
 *   r21). With it set and nothing to send, berry fails the run (r22); autd
 *   sends nothing;
 * - `npmAuthToken` is Bearer; `npmAuthIdent` is Basic, base64-encoded when
 *   it holds a `:` (r08, r09).
 */
export const berryAuthorizationFor = (
  url: URL,
  registry: string,
  config: Pick<RegistryConfig, 'registry' | 'scopedRegistries' | 'berryAuth'>,
): string | undefined => {
  const auth = config.berryAuth
  if (!auth || !isRoute(registry, config)) return undefined
  const path = pathAfter(url, registry)
  if (path === undefined) return undefined
  const scope = YARN_SCOPED.exec(path)?.[1]
  const scoped = scope ? auth.scopes[scope] : undefined
  const normalized = registry.trim().replace(/\/$/, '')
  const effective: BerryAuthEntry =
    scoped && (scoped.token || scoped.ident)
      ? scoped
      : (auth.registries[normalized] ??
        auth.registries[normalized.replace(/^[a-z]+:/, '')] ??
        auth.top)
  if (!scope && !effective.alwaysAuth) return undefined
  if (effective.token) return `Bearer ${effective.token}`
  if (effective.ident) {
    return effective.ident.includes(':')
      ? `Basic ${Buffer.from(effective.ident).toString('base64')}`
      : `Basic ${effective.ident}`
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

export interface CacheDirectives {
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

/** What `describeUrl` shows for a URL it cannot read. */
export const INVALID_URL = '(invalid URL)'

/** The public endpoints whose paths hold no secret and are shown whole. */
const PUBLIC_ORIGINS = [
  ...DEFAULT_ENDPOINTS.publicRegistries,
  DEFAULT_ENDPOINTS.depsDev,
].map((endpoint) => new URL(endpoint).origin)

/**
 * `…[3fa9c1]`: the hidden path of a registry, as the first 6 hex characters of
 * the SHA-256 of the path without its trailing slash. The same registry always
 * shows the same marker, so two registries on one host stay apart, and six
 * characters of a hash tell nothing about a token in the path.
 */
export const pathMarker = (pathname: string): string =>
  `…[${createHash('sha256')
    .update(pathname.replace(/\/+$/, ''))
    .digest('hex')
    .slice(0, 6)}]`

/**
 * A request URL as it may appear in an error, a reason or a debug line: the
 * origin, then what follows the registry's own path. Some registries keep a
 * token in that path (`https://npm-proxy.fury.io/<TOKEN>/<user>/`), so it is
 * shown as `/…[3fa9c1]` (see `pathMarker`) and the package name after it
 * stays: `https://npm-proxy.fury.io/…[3fa9c1]/left-pad`. The public npm
 * registries and deps.dev show their whole path. A redirect target, or any
 * other URL outside the registry's path, shows its origin and `/…` only, as
 * its path may hold a signed token. Userinfo and the query never show. A URL
 * or registry that does not parse gives `INVALID_URL`; this never throws.
 * Display only: nothing is sent from this.
 */
export const describeUrl = (
  url: URL | string,
  registry: string,
  { redirect = false }: { redirect?: boolean } = {},
): string => {
  try {
    const target = typeof url === 'string' ? new URL(url) : url
    if (redirect) return `${target.origin}/…`
    if (PUBLIC_ORIGINS.includes(target.origin)) {
      return `${target.origin}${target.pathname}`
    }
    let base: URL | undefined
    try {
      base = new URL(registry.trim())
    } catch {
      // An unreadable registry hides the whole path, below.
    }
    if (base?.origin === target.origin) {
      const own = base.pathname.replace(/\/+$/, '')
      if (own === '') return `${target.origin}${target.pathname}`
      if (target.pathname.startsWith(`${own}/`)) {
        return `${target.origin}/${pathMarker(own)}${target.pathname.slice(own.length)}`
      }
    }
    return `${target.origin}/…`
  } catch {
    return INVALID_URL
  }
}

/** What `describeUnusable` shows for a value that may hold a credential. */
export const VALUE_NOT_SHOWN = '(value not shown)'

/** Only `${NAME}` / `$NAME` references and spaces: the names are no secret. */
const ONLY_REFERENCES =
  /^(?:\s|\$\{[A-Za-z_][A-Za-z0-9_]*\??\}|\$[A-Za-z_][A-Za-z0-9_]*)+$/

/**
 * A registry setting the manager cannot use, as it may appear in an error.
 * The error names the file and key, so the value is only a hint, and nothing
 * that could hold a credential is shown: `<scheme>://<host>/` for a URL, or
 * `<scheme>://<host>/…[3fa9c1]` (see `pathMarker`) when it has a path. The
 * host is what follows the last `@` of the authority, which ends at the first
 * `/`, `?` or `#` after it, so a password holding a `/` leaks nothing;
 * userinfo, query and fragment never show. A value with no scheme and host
 * shows as `VALUE_NOT_SHOWN`, unless it is only variable references
 * (`${REGISTRY}`), whose names explain the error.
 */
export const describeUnusable = (value: string): string => {
  const text = value.trim()
  if (text === '') return '(empty)'
  if (ONLY_REFERENCES.test(text)) return text
  const shaped = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/is.exec(text)
  if (!shaped) return VALUE_NOT_SHOWN
  const [, scheme, rest] = shaped
  const afterUserinfo = rest.slice(rest.lastIndexOf('@') + 1)
  const hostEnd = afterUserinfo.search(/[/?#]/)
  const host = hostEnd === -1 ? afterUserinfo : afterUserinfo.slice(0, hostEnd)
  if (host === '') return VALUE_NOT_SHOWN
  const path =
    hostEnd === -1
      ? ''
      : (/^[^?#]*/.exec(afterUserinfo.slice(hostEnd))?.[0] ?? '')
  const hidden = path.replace(/\/+$/, '')
  return `${scheme.toLowerCase()}://${host}${hidden === '' ? '/' : `/${pathMarker(hidden)}`}`
}

/** `registry \`value\` from <file> (<reason>)`: an unusable setting, in an error. */
export const unusableText = ({
  key,
  value,
  source,
  reason,
}: UnusableRegistry): string => `${key} \`${value}\` from ${source} (${reason})`

/**
 * The route a package takes when the manager cannot use it: its scope's
 * unusable value, else the default's when no scope route (usable or not)
 * covers it. Undefined when the package's route is fine.
 */
export const unusableRouteFor = (
  name: string,
  config: RegistryConfig,
): UnusableRegistry | undefined => {
  const unusable = config.unusable
  if (!unusable) return undefined
  if (name.startsWith('@')) {
    const scope = name.slice(0, name.indexOf('/'))
    if (config.scopedRegistries[scope]) return undefined
    if (unusable.scopes[scope]) return unusable.scopes[scope]
  }
  return unusable.registry
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
