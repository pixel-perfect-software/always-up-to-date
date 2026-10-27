import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  matchesWorkspacePatterns,
  readManifest,
  toPosix,
  workspacePatterns,
} from '@/managers/workspaces'
import type {
  ProxySettings,
  RegistryConfig,
  RegistryCredentials,
} from '@/types'
import logger from './logger'
import {
  type Npmrc,
  type NpmrcValue,
  parseNpmrc,
  type Substitute,
  substituteEnv,
} from './npmrc'

/** What the loader reads from the machine, injectable for tests. */
export interface NpmrcSources {
  env: NodeJS.ProcessEnv
  home: string
  execPath: string
  platform: NodeJS.Platform
}

export const processSources = (): NpmrcSources => ({
  env: process.env,
  home: process.env.HOME || os.homedir(),
  execPath: process.execPath,
  platform: process.platform,
})

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? value : undefined

/** A string with something in it: npm treats an empty setting as unset (`||`). */
export const nonEmpty = (value: unknown): string | undefined =>
  typeof value === 'string' && value !== '' ? value : undefined

const boolValue = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

/** One source of .npmrc settings; a missing or unreadable file is an empty layer. */
export type NpmrcLayer =
  | { kind: 'env'; values: Npmrc }
  | { kind: 'file'; file: string; values: Npmrc }

/** The merged settings, and the layer that set each key. */
export interface NpmrcView {
  values: Npmrc
  origin(key: string): NpmrcLayer | undefined
}

/** How a manager reads its configuration variables. */
export interface EnvRule {
  /** Matches the variable names the manager reads; the rest of the name follows it. */
  prefix: RegExp
  /** The .npmrc key for a variable (`rest` is the name after the prefix); undefined skips it. */
  key(rest: string, name: string): string | undefined
  /** Applied to values; null leaves them as written. */
  substitute: Substitute | null
}

/** `npm_config_*` as npm reads it: any case, `//` keys as written, else `_` → `-` in lower case. */
export const NPM_ENV: EnvRule = {
  prefix: /^npm_config_/i,
  key: (rest) =>
    rest.startsWith('//') ? rest : rest.replace(/(?!^)_/g, '-').toLowerCase(),
  substitute: substituteEnv,
}

/** The variables `rule` reads as one layer; empty values are skipped. */
export const envLayer = (env: NodeJS.ProcessEnv, rule: EnvRule): NpmrcLayer => {
  const values: Npmrc = Object.create(null)
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue
    const match = rule.prefix.exec(name)
    if (!match) continue
    const key = rule.key(name.slice(match[0].length), name)
    if (key === undefined) continue
    values[key] = rule.substitute ? rule.substitute(value, env) : value
  }
  return { kind: 'env', values }
}

/** A key or value (or array element) still holding a `${…}` reference. */
const holdsReference = (key: string, value: NpmrcValue): boolean =>
  key.includes('${') ||
  (Array.isArray(value) ? value : [value]).some(
    (v) => typeof v === 'string' && v.includes('${'),
  )

/**
 * A file's settings as one layer. `substitute` defaults to npm's; null reads
 * the file without expanding, and an entry still holding `${…}` in its key
 * or value is left out, so a lower layer decides (pnpm's project files).
 */
export const npmrcFileLayer = (
  file: string,
  env: NodeJS.ProcessEnv,
  { substitute = substituteEnv }: { substitute?: Substitute | null } = {},
): NpmrcLayer => {
  let values: Npmrc
  try {
    values = parseNpmrc(fs.readFileSync(file, 'utf8'), env, substitute)
  } catch {
    values = Object.create(null)
  }
  if (substitute === null) {
    for (const [key, value] of Object.entries(values)) {
      if (holdsReference(key, value)) delete values[key]
    }
  }
  return { kind: 'file', file, values }
}

/** Merges layers, highest first, per key: the first layer that sets a key wins, whatever the value's type. */
export const mergeNpmrcLayers = (layers: readonly NpmrcLayer[]): NpmrcView => {
  const values: Npmrc = Object.create(null)
  const origins = new Map<string, NpmrcLayer>()
  for (const layer of [...layers].reverse()) {
    for (const key of Object.keys(layer.values)) {
      values[key] = layer.values[key]
      origins.set(key, layer)
    }
  }
  return { values, origin: (key) => origins.get(key) }
}

/** A path from config: `~/` is the home directory, the rest is relative to cwd. */
const resolveNpmPath = (
  value: string,
  home: string,
  cwd: string,
  platform: NodeJS.Platform,
): string => {
  if (
    value.startsWith('~/') ||
    (platform === 'win32' && value.startsWith('~\\'))
  ) {
    return path.resolve(home, value.slice(2))
  }
  return path.resolve(cwd, value)
}

const isFile = (filePath: string): boolean => {
  try {
    return fs.statSync(filePath).isFile()
  } catch {
    return false
  }
}

const isDirectory = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

/**
 * The directory whose .npmrc npm reads: the nearest directory with a
 * package.json or node_modules, or the root of the workspace that lists it
 * as a member.
 */
export const findNpmProjectRoot = (cwd: string): string => {
  let localPrefix: string | undefined
  let dir = path.resolve(cwd)

  for (;;) {
    const hasManifest = isFile(path.join(dir, 'package.json'))
    if (localPrefix === undefined) {
      if (hasManifest || isDirectory(path.join(dir, 'node_modules'))) {
        localPrefix = dir
      }
    } else if (hasManifest) {
      const patterns = workspacePatterns(readManifest(dir))
      if (patterns.length > 0) {
        const member = toPosix(path.relative(dir, localPrefix))
        if (
          member !== '' &&
          matchesWorkspacePatterns(patterns, member) &&
          isFile(path.join(localPrefix, 'package.json'))
        ) {
          return dir
        }
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return localPrefix ?? path.resolve(cwd)
}

/**
 * The directory npm treats as the global prefix: node's own install, found
 * from the running node. DESTDIR (npm prefixes the default prefix with it on
 * posix) is not supported.
 */
export const execPrefix = ({ execPath, platform }: NpmrcSources): string =>
  platform === 'win32'
    ? path.dirname(execPath)
    : path.dirname(path.dirname(execPath))

/**
 * npm's layers, highest first: `npm_config_*` environment variables → the
 * project's .npmrc (the nearest npm project root's) → the user's
 * (`~/.npmrc`) → the global one (`<prefix>/etc/npmrc`) → npm's builtin one.
 */
export const npmNpmrcLayers = (
  cwd: string,
  sources: NpmrcSources = processSources(),
): NpmrcLayer[] => {
  const { env, home, platform } = sources
  const envL = envLayer(env, NPM_ENV)

  const userconfigOf = (layer: Npmrc): string =>
    resolveNpmPath(
      stringValue(envL.values.userconfig) ??
        stringValue(layer.userconfig) ??
        '~/.npmrc',
      home,
      cwd,
      platform,
    )

  const projectFile = path.join(findNpmProjectRoot(cwd), '.npmrc')
  const project: NpmrcLayer =
    projectFile === userconfigOf(Object.create(null))
      ? { kind: 'file', file: projectFile, values: Object.create(null) }
      : npmrcFileLayer(projectFile, env)

  const user = npmrcFileLayer(userconfigOf(project.values), env)

  const prefixDir = execPrefix(sources)
  const builtin = npmrcFileLayer(
    platform === 'win32'
      ? path.join(prefixDir, 'node_modules', 'npm', 'npmrc')
      : path.join(prefixDir, 'lib', 'node_modules', 'npm', 'npmrc'),
    env,
  )

  const layers = [envL, project, user, builtin]
  const pick = (key: string): string | undefined => {
    for (const layer of layers) {
      const value = stringValue(layer.values[key])
      if (value !== undefined) return value
    }
    return undefined
  }

  const prefix = resolveNpmPath(
    pick('prefix') ?? nonEmpty(env.PREFIX) ?? prefixDir,
    home,
    cwd,
    platform,
  )
  const globalconfig = resolveNpmPath(
    pick('globalconfig') ?? path.resolve(prefix, 'etc/npmrc'),
    home,
    cwd,
    platform,
  )

  return [envL, project, user, npmrcFileLayer(globalconfig, env), builtin]
}

/** The merged .npmrc settings, as npm resolves them (see `npmNpmrcLayers`). */
export const loadNpmrc = (
  cwd: string,
  sources: NpmrcSources = processSources(),
): Npmrc => mergeNpmrcLayers(npmNpmrcLayers(cwd, sources)).values

/** A boolean .npmrc value (`true` / `false`, as a string or a boolean). */
export const npmrcBoolean = (value: unknown): boolean | undefined =>
  boolValue(value)

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

export const isRegistryUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value)
    return protocol === 'https:' || protocol === 'http:'
  } catch {
    return false
  }
}

/** The registry-facing view of merged .npmrc settings, with npm's defaults. */
export const registryConfigFrom = (
  npmrc: Npmrc,
  cwd: string,
  sources: NpmrcSources,
): RegistryConfig => {
  const scopedRegistries: Record<string, string> = {}
  for (const [key, value] of Object.entries(npmrc)) {
    if (typeof value !== 'string' || !/^@[^:]+:registry$/.test(key)) continue
    const scope = key.slice(0, key.indexOf(':'))
    if (isRegistryUrl(value)) scopedRegistries[scope] = value
    else logger.debug(`Ignoring ${key}: not an http(s) URL`)
  }

  const configured = npmrc.registry
  let registry = DEFAULT_REGISTRY
  if (typeof configured === 'string') {
    if (isRegistryUrl(configured)) registry = configured
    else
      logger.debug(
        `Ignoring registry: not an http(s) URL; using ${DEFAULT_REGISTRY}`,
      )
  }

  return {
    registry,
    scopedRegistries,
    credentials: credentialsFrom(npmrc, cwd),
    ca: caFrom(npmrc, cwd, sources),
    strictSSL: boolValue(npmrc['strict-ssl']) ?? true,
    proxy: proxyFrom(npmrc, sources.env),
    fetchRetries: integerAtLeast(npmrc['fetch-retries'], 0, 2),
    fetchTimeout: timeoutFrom(npmrc['fetch-timeout']),
    maxSockets: integerAtLeast(npmrc.maxsockets, 1, 15),
  }
}

/**
 * Loads .npmrc-style config the way npm does for the registry fields we care
 * about (see `loadNpmrc` for precedence). Managers that route registries
 * elsewhere adjust the result through `ManagerAdapter.registryConfig`.
 */
export const loadRegistryConfig = (
  cwd: string,
  sources: NpmrcSources = processSources(),
): RegistryConfig => registryConfigFrom(loadNpmrc(cwd, sources), cwd, sources)
