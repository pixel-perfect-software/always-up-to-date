import { createHash } from 'crypto'
import type { RegistryConfig, UnusableRegistry } from '@/types'

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

/** One version's own manifest (#196); the version escaped, so `+build` metadata survives. */
export const versionManifestUrl = (
  name: string,
  version: string,
  registry: string,
): string => `${packumentUrl(name, registry)}/${encodeURIComponent(version)}`

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
const INVALID_URL = '(invalid URL)'

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
const VALUE_NOT_SHOWN = '(value not shown)'

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
