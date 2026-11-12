import fs from 'fs'
import path from 'path'
import type {
  ProxySettings,
  RegistryConfig,
  RegistryCredentials,
  UnusableRegistries,
  UnusableRegistry,
} from '@/types'
import logger from './logger'
import { type Npmrc, nonEmpty, npmrcBoolean, resolveNpmPath } from './npmrc'
import type { NpmrcLayer, NpmrcSources, NpmrcView } from './npmrcLoader'
import { describeUnusable } from './registryUrls'

const CREDENTIAL_FIELDS: Record<string, keyof RegistryCredentials> =
  Object.assign(Object.create(null), {
    _authToken: 'authToken',
    _auth: 'auth',
    username: 'username',
    _password: 'password',
    certfile: 'certfile',
    keyfile: 'keyfile',
  })

/** A `${VAR}` the parser left in place because VAR is unset. */
const UNEXPANDED = /\$\{[^}]*\}/

const CERT_END = '-----END CERTIFICATE-----'

/** Every `//host/path/:field` key, grouped by its prefix. */
const credentialsFrom = (
  npmrc: Npmrc,
  cwd: string,
): Record<string, RegistryCredentials> => {
  const credentials: Record<string, RegistryCredentials> = {}
  for (const [key, value] of Object.entries(npmrc)) {
    if (!key.startsWith('//') || typeof value !== 'string') continue
    const colon = key.lastIndexOf(':')
    const field = CREDENTIAL_FIELDS[key.slice(colon + 1)]
    if (!field) continue
    const isPath = field === 'certfile' || field === 'keyfile'
    // A literal ${NPM_TOKEN} is never a valid secret; sending it only turns an
    // anonymous read into a 401.
    if (!isPath && UNEXPANDED.test(value)) continue
    const prefix = key.slice(0, colon)
    const entry = credentials[prefix] ?? {}
    entry[field] = isPath ? path.resolve(cwd, value) : value
    credentials[prefix] = entry
  }
  return credentials
}

const stringList = (value: unknown): string[] | undefined => {
  // An empty entry would make the Agent drop Node's default trust store.
  const strings = (Array.isArray(value) ? value : [value]).filter(
    (v): v is string => typeof v === 'string' && v.trim() !== '',
  )
  return strings.length > 0 ? strings : undefined
}

/** `cafile` (when readable) wins over `ca` / `ca[]`; undefined is Node's own store. */
const caFrom = (
  npmrc: Npmrc,
  cwd: string,
  sources: NpmrcSources,
): string[] | undefined => {
  const cafile = nonEmpty(npmrc.cafile)
  if (cafile !== undefined) {
    const file = resolveNpmPath(cafile, sources.home, cwd, sources.platform)
    try {
      const certs = fs
        .readFileSync(file, 'utf8')
        .replace(/\r\n/g, '\n')
        .split(CERT_END)
        .filter((part) => part.trim())
        .map((part) => part.trimStart() + CERT_END)
      if (certs.length > 0) return certs
    } catch (error) {
      logger.debug(
        `Could not read cafile ${file}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      )
    }
  }
  return stringList(npmrc.ca)
}

const proxyFrom = (npmrc: Npmrc, env: NodeJS.ProcessEnv): ProxySettings => {
  const configured = nonEmpty(npmrc['https-proxy']) ?? nonEmpty(npmrc.proxy)
  const proxy: ProxySettings = {}
  const httpsEnv = nonEmpty(env.https_proxy) ?? nonEmpty(env.HTTPS_PROXY)
  const https = configured ?? httpsEnv
  // For an http registry npm's agent takes https_proxy || http_proxy || proxy
  // from the environment (@npmcli/agent proxy.js).
  const http =
    configured ??
    httpsEnv ??
    nonEmpty(env.http_proxy) ??
    nonEmpty(env.HTTP_PROXY) ??
    nonEmpty(env.proxy) ??
    nonEmpty(env.PROXY)
  if (https) proxy.HTTPS_PROXY = https
  if (http) proxy.HTTP_PROXY = http

  const noproxy = npmrc.noproxy
  const raw =
    (Array.isArray(noproxy)
      ? noproxy.filter((v) => typeof v === 'string').join(',')
      : nonEmpty(noproxy)) ||
    nonEmpty(env.no_proxy) ||
    nonEmpty(env.NO_PROXY) ||
    ''
  const entries = raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
  // npm matches a bare host as a suffix too; Node's NO_PROXY needs `.host` for that.
  const widened = entries.flatMap((entry) =>
    entry.startsWith('.') || entry.startsWith('*')
      ? [entry]
      : [entry, `.${entry}`],
  )
  if (widened.length > 0) proxy.NO_PROXY = widened.join(',')
  return proxy
}

const integerAtLeast = (
  value: unknown,
  min: number,
  fallback: number,
): number => {
  const n = typeof value === 'string' ? Number(value) : Number.NaN
  return Number.isInteger(n) && n >= min ? n : fallback
}

const MAX_TIMER_MS = 2 ** 31 - 1

const timeoutFrom = (value: unknown): number => {
  if (typeof value !== 'string' || value.trim() === '') return 300_000
  const n = Number(value)
  if (!Number.isInteger(n) || n < 0) return 300_000
  // AbortSignal.timeout treats anything above 2^31-1 ms as 1 ms.
  return n === 0 ? 30_000 : Math.min(n, MAX_TIMER_MS)
}

export const DEFAULT_REGISTRY = 'https://registry.npmjs.org/'

/** Why a manager cannot use `value` as a registry, or undefined when it can. */
export const registryProblem = (value: string): string | undefined => {
  if (value.trim() === '') return 'it is empty'
  // Checked before the parse: `https://${REGISTRY_HOST}/` parses, to a host
  // named `${registry_host}` (npm 11.19.1 fails on it with ENOTFOUND).
  if (value.includes('${')) return 'it still holds an unexpanded ${…}'
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return 'it is not a valid URL'
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'it is not an http(s) URL'
  }
  if (url.hostname.includes('$')) {
    return 'its host still holds an unexpanded $NAME'
  }
  return undefined
}

/**
 * A setting the manager cannot use, as `RegistryConfig.unusable` keeps it:
 * the value is only ever shown through `describeUnusable`.
 */
export const unusableEntry = ({
  key,
  value,
  source,
  reason,
}: UnusableRegistry): UnusableRegistry => ({
  key,
  value: describeUnusable(value),
  source,
  reason,
})

/** `config` with `unusable` as its unusable routes, or none when it holds none. */
export const withUnusable = (
  config: RegistryConfig,
  unusable: UnusableRegistries,
): RegistryConfig => {
  const { unusable: _replaced, ...rest } = config
  return unusable.registry || Object.keys(unusable.scopes).length > 0
    ? { ...rest, unusable }
    : rest
}

/** Where `key` was set and what that source calls it: the file or the environment, and e.g. the variable's name. */
export const layerOrigin = (
  layer: NpmrcLayer | undefined,
  key: string,
): { source: string; key: string } => ({
  source: layer?.kind === 'file' ? layer.file : 'the environment',
  key: layer?.labels?.[key] ?? key,
})

/**
 * Whether an empty registry value fails the manager's run (verified
 * 2026-10-27: npm 11.19.1 fails on an empty `registry` and ignores an empty
 * scope; pnpm 12.15.0 fails on both; yarn 1.22.22 and bun 1.4.4 ignore both).
 */
export interface EmptyRegistryPolicy {
  registry: boolean
  scopes: boolean
}

const NPM_EMPTY_REGISTRY: EmptyRegistryPolicy = {
  registry: true,
  scopes: false,
}

/**
 * The registry-facing view of merged .npmrc settings, with npm's defaults. A
 * value the manager cannot use is recorded in `unusable` (named through the
 * view's `origin`), not replaced: see `UnusableRegistry`.
 */
export const registryConfigFrom = (
  npmrc: NpmrcView,
  cwd: string,
  sources: NpmrcSources,
  empty: EmptyRegistryPolicy = NPM_EMPTY_REGISTRY,
): RegistryConfig => {
  const values = npmrc.values
  const unusable: UnusableRegistries = { scopes: {} }
  const reject = (
    key: string,
    value: string,
    reason: string,
  ): UnusableRegistry =>
    unusableEntry({ ...layerOrigin(npmrc.origin(key), key), value, reason })

  const scopedRegistries: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== 'string' || !/^@[^:]+:registry$/.test(key)) continue
    const scope = key.slice(0, key.indexOf(':'))
    const problem = registryProblem(value)
    if (problem === undefined) scopedRegistries[scope] = value
    else if (value.trim() === '' && !empty.scopes) {
      logger.debug(`Ignoring ${key}: empty`)
    } else unusable.scopes[scope] = reject(key, value, problem)
  }

  const configured = values.registry
  let registry = DEFAULT_REGISTRY
  if (typeof configured === 'string') {
    const problem = registryProblem(configured)
    if (problem === undefined) registry = configured
    else if (configured.trim() === '' && !empty.registry) {
      logger.debug(`Ignoring registry: empty; using ${DEFAULT_REGISTRY}`)
    } else unusable.registry = reject('registry', configured, problem)
  }

  return withUnusable(
    {
      registry,
      scopedRegistries,
      credentials: credentialsFrom(values, cwd),
      ca: caFrom(values, cwd, sources),
      strictSSL: npmrcBoolean(values['strict-ssl']) ?? true,
      proxy: proxyFrom(values, sources.env),
      fetchRetries: integerAtLeast(values['fetch-retries'], 0, 2),
      fetchTimeout: timeoutFrom(values['fetch-timeout']),
      maxSockets: integerAtLeast(values.maxsockets, 1, 15),
    },
    unusable,
  )
}
