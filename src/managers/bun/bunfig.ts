import path from 'path'

import type { RegistryConfig, RegistryCredentials } from '@/types'
import logger from '@/utils/logger'
import {
  DEFAULT_REGISTRY,
  isRegistryUrl,
  type NpmrcSources,
} from '@/utils/npmrcLoader'
import { nerfDart } from '@/utils/registryRequest'
import { readTextFile } from '@/utils/saveStyle'

/** `exact = true` inside bunfig.toml's `[install]` table. */
export const bunfigExact = (content: string): boolean => {
  let inInstall = false
  for (const line of content.split('\n')) {
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

/** The line without its `#` comment, which may sit after quoted text. */
const stripComment = (line: string): string => {
  let quote: string | undefined
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === quote && (quote === "'" || line[i - 1] !== '\\')) {
        quote = undefined
      }
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#') return line.slice(0, i)
  }
  return line
}

/** Splits at `separator` outside quotes, `{}` and `[]`. */
const splitTop = (text: string, separator: string): string[] => {
  const parts: string[] = []
  let quote: string | undefined
  let depth = 0
  let from = 0
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (quote) {
      if (c === quote && (quote === "'" || text[i - 1] !== '\\')) {
        quote = undefined
      }
    } else if (c === '"' || c === "'") quote = c
    else if (c === '{' || c === '[') depth++
    else if (c === '}' || c === ']') depth--
    else if (c === separator && depth === 0) {
      parts.push(text.slice(from, i))
      from = i + 1
    }
  }
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

/** `[install] registry` and `[install.scopes]` from a bunfig.toml. */
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
    if (table !== 'install' && table !== 'install.scopes') continue
    const [key, ...rest] = splitTop(text, '=')
    if (rest.length === 0) continue
    const name = tomlKey(key)
    const value = tomlValue(rest.join('='))
    if (value === undefined) continue
    if (table === 'install.scopes') {
      result.scopes[name.startsWith('@') ? name : `@${name}`] = value
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
}

const base64 = (value: string): string =>
  Buffer.from(value, 'utf8').toString('base64')

const decode = (value: string): string => {
  try {
    return decodeURIComponent(value)
  } catch {
    return value
  }
}

/**
 * `$NAME` in a token, as bun expands it (verified on bun 1.4.4, 2026-10-26).
 * `${NAME}` is sent as is by bun, and an unset `$NAME` drops the credential;
 * both leave nothing worth sending, so both give undefined.
 */
const expandToken = (
  token: string,
  env: NodeJS.ProcessEnv,
  where: string,
): string | undefined => {
  if (token.includes('${')) {
    logger.debug(`Ignoring token for ${where} in bunfig.toml: holds \${…}`)
    return undefined
  }
  let unset: string | undefined
  const expanded = token.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_, name) => {
    const value = env[name]
    if (!value) unset ??= name
    return value ?? ''
  })
  if (unset !== undefined) {
    logger.debug(
      `Ignoring token for ${where} in bunfig.toml: $${unset} is not set`,
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
  if (!entry.url) return undefined
  // bun fails the install on a `$` in a registry URL (InvalidURL).
  if (entry.url.includes('$')) {
    logger.debug(`Ignoring ${where} in bunfig.toml: a variable in a URL`)
    return undefined
  }
  let url: URL
  try {
    url = new URL(entry.url)
  } catch {
    logger.debug(`Ignoring ${where} in bunfig.toml: not a URL`)
    return undefined
  }
  if (!isRegistryUrl(entry.url)) {
    logger.debug(`Ignoring ${where} in bunfig.toml: not an http(s) URL`)
    return undefined
  }

  const credentials: RegistryCredentials = {}
  if (url.username && url.password) {
    credentials.username = decode(url.username)
    credentials.password = base64(decode(url.password))
  }
  url.username = ''
  url.password = ''
  if (entry.token !== undefined) {
    credentials.authToken = expandToken(entry.token, env, where)
  }
  if (entry.username && entry.password) {
    credentials.username = entry.username
    credentials.password = base64(entry.password)
  }
  const held = credentials.authToken || credentials.username
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

const nonEmpty = (value: string | undefined): string | undefined =>
  value ? value : undefined

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
 * Not read yet: `$XDG_CONFIG_HOME/.npmrc`, which bun reads in place of
 * `~/.npmrc`, and that autd also layers npm's global npmrc.
 */
export const bunRegistryConfig = (
  cwd: string,
  base: RegistryConfig,
  sources: NpmrcSources,
): RegistryConfig => {
  const { env } = sources
  const global = parseBunfigRegistries(readTextFile(globalBunfig(sources)), env)
  const project = parseBunfigRegistries(
    readTextFile(path.join(cwd, 'bunfig.toml')),
    env,
  )

  const fromEnv = [
    env.BUN_CONFIG_REGISTRY,
    env.NPM_CONFIG_REGISTRY,
    env.npm_config_registry,
  ].find((value) => value && isRegistryUrl(value))
  const route = fromEnv ? undefined : (project.registry ?? global.registry)

  const registry = fromEnv ?? route?.url ?? base.registry
  const credentials = { ...base.credentials }
  const token = nonEmpty(env.BUN_CONFIG_TOKEN) ?? nonEmpty(env.NPM_CONFIG_TOKEN)
  // A token with no registry configured is not sent to the public default.
  const defaultCredentials =
    route?.credentials ??
    (token && registry !== DEFAULT_REGISTRY ? { authToken: token } : undefined)
  if (defaultCredentials) credentials[nerfDart(registry)] = defaultCredentials

  const scopedRegistries = { ...base.scopedRegistries }
  for (const [scope, scoped] of Object.entries({
    ...global.scopes,
    ...project.scopes,
  })) {
    scopedRegistries[scope] = scoped.url
    if (scoped.credentials)
      credentials[nerfDart(scoped.url)] = scoped.credentials
  }

  return { ...base, registry, scopedRegistries, credentials }
}
