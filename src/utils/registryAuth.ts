import type {
  BerryAuthEntry,
  RegistryConfig,
  RegistryCredentials,
  YarnV1Auth,
} from '@/types'

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
 * `Authorization` (#107, probes r01-r30, each a case in `__tests__/utils/registryRequest.test.ts`):
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
