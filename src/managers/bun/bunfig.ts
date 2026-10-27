import path from 'path'

import type {
  RegistryConfig,
  RegistryCredentials,
  UnusableRegistry,
} from '@/types'
import logger from '@/utils/logger'
import {
  findNpmProjectRoot,
  type NpmrcSources,
  nonEmpty,
  registryProblem,
  unusableEntry,
  withUnusable,
} from '@/utils/npmrcLoader'
import {
  DEFAULT_ENDPOINTS,
  decodeUri,
  isPublicNpmRegistry,
  nerfDart,
} from '@/utils/registryRequest'
import { readTextFile } from '@/utils/saveStyle'

/** `exact = true` inside bunfig.toml's `[install]` table. */
export const bunfigExact = (content: string): boolean => {
  let inInstall = false
  for (const line of content.split(/\r?\n/)) {
    const table = /^\s*\[([^\]]+)\]/.exec(line)
    if (table) {
      inInstall = table[1].trim() === 'install'
      continue
    }
    if (inInstall && /^\s*exact\s*=\s*true\s*(#.*)?$/.test(line)) return true
  }
  return false
}

/** A string, or an inline table of strings: the two shapes a registry takes. */
type TomlValue = string | Record<string, string>

/**
 * Calls `visit` for each character outside a TOML string; `visit` returns
 * true to stop. A backslash escapes the next character in a basic string
 * (`"`), so `"a\\"` ends at its second quote; a literal string (`'`) has no
 * escapes.
 */
const scanOutsideStrings = (
  text: string,
  visit: (char: string, index: number) => boolean | undefined,
): void => {
  let quote: string | undefined
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = undefined
    } else if (c === '"' || c === "'") quote = c
    else if (visit(c, i)) return
  }
}

/** The line without its `#` comment, which may sit after quoted text. */
const stripComment = (line: string): string => {
  let end = line.length
  scanOutsideStrings(line, (c, i) => {
    if (c !== '#') return undefined
    end = i
    return true
  })
  return line.slice(0, end)
}

/** Splits at `separator` outside strings, `{}` and `[]`. */
const splitTop = (text: string, separator: string): string[] => {
  const parts: string[] = []
  let depth = 0
  let from = 0
  scanOutsideStrings(text, (c, i) => {
    if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === separator && depth === 0) {
      parts.push(text.slice(from, i))
      from = i + 1
    }
    return undefined
  })
  parts.push(text.slice(from))
  return parts
}

/** A basic or literal TOML string; undefined for anything else. */
const tomlString = (raw: string): string | undefined => {
  const text = raw.trim()
  const basic = /^"((?:[^"\\]|\\.)*)"$/.exec(text)
  if (basic) return basic[1].replace(/\\(["\\])/g, '$1')
  return /^'([^']*)'$/.exec(text)?.[1]
}

/** A bare or quoted key. */
const tomlKey = (raw: string): string => tomlString(raw) ?? raw.trim()

const tomlValue = (raw: string): TomlValue | undefined => {
  const text = raw.trim()
  if (text.startsWith('{') && text.endsWith('}')) {
    const table: Record<string, string> = {}
    for (const pair of splitTop(text.slice(1, -1), ',')) {
      const [key, ...value] = splitTop(pair, '=')
      const string = tomlString(value.join('='))
      if (key.trim() !== '' && string !== undefined) {
        table[tomlKey(key)] = string
      }
    }
    return table
  }
  return tomlString(text)
}

interface BunfigRegistries {
  registry?: TomlValue
  /** Keyed with the leading `@`, whether or not the file wrote it. */
  scopes: Record<string, TomlValue>
}

const SCOPES_TABLE = 'install.scopes.'

const scopeName = (name: string): string =>
  name.startsWith('@') ? name : `@${name}`

/**
 * `[install] registry`, `[install.scopes]` and `[install.scopes.<name>]`
 * from a bunfig.toml. Dotted keys (`scopes.acme = …`) and
 * `scopes = { … }` are not read.
 */
const readBunfigRegistries = (content: string): BunfigRegistries => {
  const result: BunfigRegistries = { scopes: {} }
  let table = ''
  for (const line of content.split(/\r?\n/)) {
    const text = stripComment(line).trim()
    if (text === '') continue
    const header = /^\[([^[\]]+)\]$/.exec(text)
    if (header) {
      table = header[1].trim()
      continue
    }
    const subtable = table.startsWith(SCOPES_TABLE)
      ? scopeName(tomlKey(table.slice(SCOPES_TABLE.length)))
      : undefined
    if (table !== 'install' && table !== 'install.scopes' && !subtable) continue
    const [key, ...rest] = splitTop(text, '=')
    if (rest.length === 0) continue
    const name = tomlKey(key)
    const value = tomlValue(rest.join('='))
    if (value === undefined) continue
    if (subtable) {
      // `[install.scopes.acme]` with url / token / username / password keys:
      // the inline-table form, one key per line.
      const existing = result.scopes[subtable]
      result.scopes[subtable] = {
        ...(typeof existing === 'object' ? existing : {}),
        ...(typeof value === 'string' ? { [name]: value } : {}),
      }
    } else if (table === 'install.scopes') {
      result.scopes[scopeName(name)] = value
    } else if (name === 'registry') {
      result.registry = value
    }
  }
  return result
}

/** A registry route from bunfig.toml, with the credentials it carries inline. */
interface Route {
  url: string
  credentials?: RegistryCredentials
  /** Why bun cannot use `url` (it fails the install on it); no credentials then. */
  problem?: string
}

const base64 = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64')

/**
 * `$NAME` in a token, username or password, as bun expands it (verified on
 * bun 1.4.4, 2026-10-26). `${NAME}` is sent as is by bun, and an unset
 * `$NAME` drops the credential; both leave nothing worth sending, so both
 * give undefined.
 */
const expandSecret = (
  secret: string,
  env: NodeJS.ProcessEnv,
  where: string,
  what: string,
): string | undefined => {
  if (secret.includes('${')) {
    logger.debug(`Ignoring ${what} for ${where} in bunfig.toml: holds \${…}`)
    return undefined
  }
  let unset: string | undefined
  const expanded = secret.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    const value = env[name]
    if (!value) unset ??= name
    return value ?? ''
  })
  if (unset !== undefined) {
    logger.debug(
      `Ignoring ${what} for ${where} in bunfig.toml: $${unset} is not set`,
    )
    return undefined
  }
  return expanded === '' ? undefined : expanded
}

const routeFrom = (
  value: TomlValue,
  env: NodeJS.ProcessEnv,
  where: string,
): Route | undefined => {
  const entry = typeof value === 'string' ? { url: value } : value
  if (!entry.url?.trim()) return undefined
  // bun fails the install on a `$` in a registry URL (InvalidURL).
  const problem = entry.url.includes('$')
    ? 'it holds a `$` that bun does not expand in bunfig.toml'
    : registryProblem(entry.url)
  if (problem) {
    logger.debug(`${where} in bunfig.toml is unusable: ${problem}`)
    return { url: entry.url, problem }
  }
  const url = new URL(entry.url)

  const credentials: RegistryCredentials = {}
  if (url.username && url.password) {
    credentials.username = decodeUri(url.username)
    credentials.password = base64(decodeUri(url.password))
  } else if (url.username) {
    // `http://TOKEN@host/`: bun sends Basic `TOKEN:`, an empty password.
    credentials.auth = base64(`${decodeUri(url.username)}:`)
  }
  url.username = ''
  url.password = ''
  if (entry.token !== undefined) {
    credentials.authToken = expandSecret(entry.token, env, where, 'token')
  }
  if (entry.username && entry.password) {
    const username = expandSecret(entry.username, env, where, 'username')
    const password = expandSecret(entry.password, env, where, 'password')
    if (username && password) {
      credentials.username = username
      credentials.password = base64(password)
    }
  }
  const held = credentials.authToken || credentials.username || credentials.auth
  return { url: url.href, credentials: held ? credentials : undefined }
}

/** The routes one bunfig.toml sets: the default registry and each scope's. */
export const parseBunfigRegistries = (
  content: string,
  env: NodeJS.ProcessEnv,
): { registry?: Route; scopes: Record<string, Route> } => {
  const read = readBunfigRegistries(content)
  const scopes: Record<string, Route> = {}
  for (const [scope, value] of Object.entries(read.scopes)) {
    const route = routeFrom(value, env, `scope ${scope}`)
    if (route) scopes[scope] = route
  }
  return {
    registry:
      read.registry === undefined
        ? undefined
        : routeFrom(read.registry, env, 'registry'),
    scopes,
  }
}

/**
 * bun reads one global bunfig: `$XDG_CONFIG_HOME/.bunfig.toml` when that is
 * an absolute path, else `$HOME/.bunfig.toml` (never `~/.config/`).
 */
const globalBunfig = ({ env, home }: NpmrcSources): string => {
  const xdg = nonEmpty(env.XDG_CONFIG_HOME)
  return path.join(xdg && path.isAbsolute(xdg) ? xdg : home, '.bunfig.toml')
}

/**
 * The registry config bun resolves, over the .npmrc view `base`. Per key,
 * the highest source wins (verified on bun 1.4.4, 2026-10-26):
 * - the default registry: `BUN_CONFIG_REGISTRY`, then `NPM_CONFIG_REGISTRY` /
 *   `npm_config_registry`, then the project bunfig.toml, then the global one,
 *   then .npmrc (`base`);
 * - a scope: the project bunfig.toml's `[install.scopes]`, then the global
 *   one, then .npmrc (`@scope:registry`);
 * - credentials for a route: an inline `token` / `username` + `password` /
 *   URL userinfo, then (for the default registry) `BUN_CONFIG_TOKEN` /
 *   `NPM_CONFIG_TOKEN`, then the .npmrc entry for the host.
 * `base` is the merge of bun's own `.npmrc` layers (`bunNpmrcLayers`), which
 * carry no environment, so the variables above are read here, not through
 * `base`. A token with `${…}` left in it is never sent (bun sends it literally).
 */
export const bunRegistryConfig = (
  cwd: string,
  base: RegistryConfig,
  sources: NpmrcSources,
): RegistryConfig => {
  const { env } = sources
  const global = parseBunfigRegistries(readTextFile(globalBunfig(sources)), env)
  const project = parseBunfigRegistries(
    readTextFile(path.join(findNpmProjectRoot(cwd), 'bunfig.toml')),
    env,
  )

  const projectFile = path.join(findNpmProjectRoot(cwd), 'bunfig.toml')
  const globalFile = globalBunfig(sources)
  const reject = (
    key: string,
    route: Route,
    source: string,
  ): UnusableRegistry =>
    unusableEntry({
      key,
      value: route.url,
      source,
      reason: route.problem ?? 'it is not usable',
    })

  const envName = [
    'BUN_CONFIG_REGISTRY',
    'NPM_CONFIG_REGISTRY',
    'npm_config_registry',
  ].find((name) => env[name]?.trim())
  const fromEnv: Route | undefined = envName
    ? {
        url: env[envName] ?? '',
        problem: registryProblem(env[envName] ?? ''),
      }
    : undefined
  const winner: { route: Route; key: string; source: string } | undefined =
    fromEnv && envName
      ? { route: fromEnv, key: envName, source: 'the environment' }
      : project.registry
        ? {
            route: project.registry,
            key: 'install.registry',
            source: projectFile,
          }
        : global.registry
          ? {
              route: global.registry,
              key: 'install.registry',
              source: globalFile,
            }
          : undefined
  const route = winner?.route.problem ? undefined : winner?.route
  const unusable = {
    registry: base.unusable?.registry,
    scopes: { ...base.unusable?.scopes },
  }
  if (winner) {
    unusable.registry = winner.route.problem
      ? reject(winner.key, winner.route, winner.source)
      : undefined
  }

  const registry = route?.url ?? base.registry
  const credentials = { ...base.credentials }
  const token = nonEmpty(env.BUN_CONFIG_TOKEN) ?? nonEmpty(env.NPM_CONFIG_TOKEN)
  // A token with no registry configured is not sent to a public registry.
  const defaultCredentials =
    route?.credentials ??
    (token && !isPublicNpmRegistry(registry, DEFAULT_ENDPOINTS.publicRegistries)
      ? { authToken: token }
      : undefined)
  const defaultPrefix = nerfDart(registry)
  if (defaultCredentials) credentials[defaultPrefix] = defaultCredentials

  const scopedRegistries = { ...base.scopedRegistries }
  const routed = new Map<string, { route: Route; source: string }>()
  for (const [file, routes] of [
    [globalFile, global.scopes],
    [projectFile, project.scopes],
  ] as const) {
    for (const [scope, found] of Object.entries(routes)) {
      routed.set(scope, { route: found, source: file })
    }
  }
  for (const [scope, { route: scoped, source }] of routed) {
    if (scoped.problem) {
      delete scopedRegistries[scope]
      unusable.scopes[scope] = reject(
        `install.scopes."${scope}"`,
        scoped,
        source,
      )
      continue
    }
    delete unusable.scopes[scope]
    scopedRegistries[scope] = scoped.url
    if (!scoped.credentials) continue
    // A credential is stored per URL prefix, as .npmrc does, so a scope on the
    // default route's prefix would replace the default's; the default wins.
    const prefix = nerfDart(scoped.url)
    if (defaultCredentials && prefix === defaultPrefix) {
      logger.debug(
        `Ignoring credentials for scope ${scope} in bunfig.toml: its registry (${new URL(scoped.url).host}) shares the default registry's route, which has its own`,
      )
      continue
    }
    credentials[prefix] = scoped.credentials
  }

  return withUnusable(
    { ...base, registry, scopedRegistries, credentials },
    unusable,
  )
}
