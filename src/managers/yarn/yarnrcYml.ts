import fs from 'fs'
import path from 'path'

import type {
  BerryAuth,
  BerryAuthEntry,
  RegistryConfig,
  ReleaseAgeGate,
  UnusableRegistries,
} from '@/types'
import { ancestorFiles } from '@/utils/ancestors'
import logger from '@/utils/logger'
import {
  type NpmrcSources,
  registryProblem,
  unusableEntry,
  withUnusable,
} from '@/utils/npmrcLoader'
import { exemptionOf } from '@/utils/releaseAgeGate'
import { parseYaml, type YamlNode } from '@/utils/yaml'

/**
 * yarn berry's registry settings, from its `.yarnrc.yml` files and `YARN_*`
 * variables (#107). Berry reads no `.npmrc` (probe r19). Verified on yarn
 * 4.18.1, 2026-11-03: `yarn install` against local registries logging each
 * request, and `yarn config get <key> --json`; each row is a case in
 * `__tests__/managers/yarnrcYml.test.ts` and `__tests__/utils/registryRequest.test.ts`.
 */

/** `.yarnrc.yml` is read with the shared YAML subset reader. */
export const parseYarnrcYml = parseYaml
export type { YamlNode }

/**
 * Berry's `${…}` substitution, as yarn 4.18.1's bundle has it: `${NAME}`
 * (unset fails), `${NAME-fallback}` (unset), `${NAME:-fallback}` (unset or
 * empty), fallbacks nesting, and `\$`, `\}` and `\\` escapes. Throws as
 * berry does: an unset variable with no fallback, `${` without a valid
 * name, an unclosed substitution.
 */
export const substituteBerry = (
  text: string,
  env: NodeJS.ProcessEnv,
): string => {
  const pattern =
    /\\(?<escaped>[\\$}])|\$\{(?<variable>[a-zA-Z]\w*)(?<operator>:-|-|(?=\}))|(?<unknown>\$\{)|\}/g
  const matches = [...text.matchAll(pattern)]
  let out = ''
  let last = 0
  let depth = 0
  let index = 0
  // From a substitution that used its variable, skip to its closing brace.
  const closeOf = (): number => {
    const level = depth
    for (; index < matches.length; index++) {
      const match = matches[index]
      if (match.groups?.variable) depth++
      else if (match[0] === '}' && --depth < level) {
        return (match.index ?? 0) + match[0].length
      }
    }
    return text.length
  }
  for (; index < matches.length; index++) {
    const match = matches[index]
    const at = match.index ?? 0
    const { escaped, variable, operator, unknown } = match.groups ?? {}
    out += text.slice(last, at)
    last = at + match[0].length
    if (escaped) out += escaped
    else if (variable) {
      const value = env[variable]
      depth++
      if (
        (operator === '' && value !== undefined) ||
        (operator === ':-' && value !== undefined && value !== '') ||
        (operator === '-' && value !== undefined)
      ) {
        // Like berry's, the skip shares the loop's matches: it consumes up to
        // the closing brace, and the loop goes on after it.
        out += value
        index++
        last = closeOf()
      } else if (operator === '') {
        throw new Error(`Environment variable not found (${variable})`)
      }
    } else if (match[0] === '}') {
      if (depth === 0) out += '}'
      else depth--
    } else if (unknown) {
      throw new Error(
        `Invalid environment variable substitution syntax: ${text}`,
      )
    }
  }
  if (depth > 0) {
    throw new Error(`Incomplete variable substitution in input: ${text}`)
  }
  return out + text.slice(last)
}

/** One setting's value and where it came from. */
interface Sourced<T> {
  value: T
  source: string
  /** The key as that source spells it (`npmRegistryServer`, `YARN_NPM_REGISTRY_SERVER`). */
  key: string
}

/** The npm settings of one scope or one `npmRegistries` entry. */
interface NpmEntry {
  npmRegistryServer?: Sourced<string>
  npmAuthToken?: Sourced<string>
  npmAuthIdent?: Sourced<string>
  npmAlwaysAuth?: Sourced<string>
  npmMinimalAgeGate?: Sourced<string>
}

const ENTRY_KEYS = [
  'npmRegistryServer',
  'npmAuthToken',
  'npmAuthIdent',
  'npmAlwaysAuth',
  'npmMinimalAgeGate',
] as const

const SCALARS = [
  ...ENTRY_KEYS,
  'httpProxy',
  'httpsProxy',
  'httpsCaFilePath',
  'httpTimeout',
  'httpRetry',
  'networkConcurrency',
  'enableStrictSsl',
] as const

type Scalar = (typeof SCALARS)[number]

/** Berry's merged settings that autd reads. */
export interface BerrySettings {
  scalars: Partial<Record<Scalar, Sourced<string>>>
  /** Scope name without `@` → its settings. */
  scopes: Record<string, NpmEntry>
  /** Registry key with one trailing `/` dropped → its settings. */
  registries: Record<string, NpmEntry>
  unsafeHttpWhitelist: string[]
  npmPreapprovedPackages: string[]
}

/** `YARN_NPM_REGISTRY_SERVER` for `npmRegistryServer`. */
const envName = (setting: string): string =>
  `YARN_${setting.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}`

/** A berry boolean: `true` / `1`, `false` / `0`; anything else is not one. */
export const berryBoolean = (value: string | undefined): boolean | undefined =>
  value === 'true' || value === '1'
    ? true
    : value === 'false' || value === '0'
      ? false
      : undefined

const isMap = (node: YamlNode | undefined): node is Record<string, YamlNode> =>
  node !== null &&
  node !== undefined &&
  typeof node === 'object' &&
  !Array.isArray(node)

/**
 * The `.yarnrc.yml` files berry reads for `cwd`, nearest first: the
 * directory's and every parent's (r14), then the home directory's (r13).
 * `YARN_RC_FILENAME` renames them.
 */
export const berryRcFiles = (cwd: string, sources: NpmrcSources): string[] => {
  const name = sources.env.YARN_RC_FILENAME || '.yarnrc.yml'
  const files = ancestorFiles(cwd, name)
  const home = path.join(sources.home, name)
  return files.includes(home) ? files : [...files, home]
}

/**
 * Merges the files nearest first, and the `YARN_*` variables over them:
 * - a scalar: the first source that sets it;
 * - `npmScopes` and `npmRegistries`: per entry, then per key (r15). Two
 *   `npmRegistries` keys that differ by a trailing `/` are one registry,
 *   and the nearer file's entry wins whole, as `yarn config get` shows;
 * - `unsafeHttpWhitelist`: every file's, concatenated.
 * String values go through `substituteBerry`. One that fails is left out,
 * with a debug line; berry fails the run on it (r18).
 */
export const berrySettings = (
  cwd: string,
  sources: NpmrcSources,
): BerrySettings => {
  const settings: BerrySettings = {
    scalars: {},
    scopes: Object.create(null),
    registries: Object.create(null),
    unsafeHttpWhitelist: [],
    npmPreapprovedPackages: [],
  }
  const { env } = sources

  const resolve = (
    raw: YamlNode | undefined,
    source: string,
    key: string,
  ): Sourced<string> | undefined => {
    if (typeof raw !== 'string') return undefined
    try {
      return { value: substituteBerry(raw, env), source, key }
    } catch (error) {
      logger.debug(`Ignoring ${key} in ${source}: ${(error as Error).message}`)
      return undefined
    }
  }

  for (const [setting, name] of SCALARS.map((s) => [s, envName(s)] as const)) {
    const value = env[name]
    if (value !== undefined && value !== '') {
      settings.scalars[setting] = {
        value,
        source: 'the environment',
        key: name,
      }
    }
  }

  // Raw npmRegistries keys, nearest file first, before normalizing.
  const rawRegistries: { key: string; entry: NpmEntry }[] = []
  const whitelists: string[][] = []
  const preapproved: string[][] = []

  for (const file of berryRcFiles(cwd, sources)) {
    let values: Record<string, YamlNode>
    try {
      values = parseYaml(fs.readFileSync(file, 'utf8'))
    } catch {
      continue
    }
    for (const setting of SCALARS) {
      if (settings.scalars[setting]) continue
      const found = resolve(values[setting], file, setting)
      if (found) settings.scalars[setting] = found
    }

    const mergeEntry = (into: NpmEntry, node: YamlNode, prefix: string) => {
      if (!isMap(node)) return
      for (const key of ENTRY_KEYS) {
        if (into[key]) continue
        const found = resolve(node[key], file, `${prefix}.${key}`)
        if (found) into[key] = found
      }
    }

    const scopes = values.npmScopes
    if (isMap(scopes)) {
      for (const [scope, node] of Object.entries(scopes)) {
        const name = scope.replace(/^@/, '')
        settings.scopes[name] ??= {}
        mergeEntry(settings.scopes[name], node, `npmScopes.${scope}`)
      }
    }
    const registries = values.npmRegistries
    if (isMap(registries)) {
      for (const [key, node] of Object.entries(registries)) {
        let raw = rawRegistries.find((r) => r.key === key)
        if (!raw) {
          raw = { key, entry: {} }
          rawRegistries.push(raw)
        }
        mergeEntry(raw.entry, node, `npmRegistries."${key}"`)
      }
    }
    const strings = (node: YamlNode | undefined): string[] | undefined =>
      Array.isArray(node)
        ? node.filter((item): item is string => typeof item === 'string')
        : undefined
    const whitelist = strings(values.unsafeHttpWhitelist)
    if (whitelist) whitelists.push(whitelist)
    const approved = strings(values.npmPreapprovedPackages)
    if (approved) preapproved.push(approved)
  }

  // Nearest file first, so the first raw key to claim a registry keeps it.
  for (const { key, entry } of rawRegistries) {
    const normalized = key.replace(/\/$/, '')
    settings.registries[normalized] ??= entry
  }
  settings.unsafeHttpWhitelist = whitelists.reverse().flat()
  settings.npmPreapprovedPackages = preapproved.reverse().flat()
  return settings
}

const DURATION_UNITS: Record<string, number> = {
  ms: 1,
  s: 1e3,
  m: 6e4,
  h: 36e5,
  d: 864e5,
  w: 6048e5,
}

/**
 * Berry's DURATION (`eF` in its bundle): a number in the setting's own
 * `unit`, or one followed by `ms`, `s`, `m`, `h`, `d` or `w`, with no space.
 * Undefined when it doesn't parse (berry fails on it).
 */
export const berryDuration = (
  value: string | undefined,
  unit: keyof typeof DURATION_UNITS,
): number | undefined => {
  const match = /^(\d*\.?\d+)(ms|s|m|h|d|w)?$/.exec(value ?? '')
  if (!match) return undefined
  const n = Number.parseFloat(match[1])
  return match[2] ? (n * DURATION_UNITS[match[2]]) / DURATION_UNITS[unit] : n
}

const wholeAtLeast = (
  value: string | undefined,
  min: number,
  fallback: number,
): number => {
  const n = Number(value)
  return value !== undefined && Number.isInteger(n) && n >= min ? n : fallback
}

/** A hostname glob of `unsafeHttpWhitelist`: `*` any run of characters, `?` one. */
const hostMatches = (glob: string, host: string): boolean =>
  new RegExp(
    `^${glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.')}$`,
    'i',
  ).test(host)

const CERT_END = '-----END CERTIFICATE-----'

const authEntry = (
  entry: NpmEntry | Partial<Record<Scalar, Sourced<string>>>,
): BerryAuthEntry => {
  const credential = (found: Sourced<string> | undefined) =>
    found && found.value !== '' ? found.value : undefined
  return {
    token: credential(entry.npmAuthToken),
    ident: credential(entry.npmAuthIdent),
    alwaysAuth: berryBoolean(entry.npmAlwaysAuth?.value) ?? false,
  }
}

export const DEFAULT_BERRY_REGISTRY = 'https://registry.yarnpkg.com'

/** `npmMinimalAgeGate`'s default, `1d`, in minutes. */
export const DEFAULT_BERRY_AGE_GATE_MINUTES = 1440

/**
 * The registry config yarn berry resolves (#107), replacing the `.npmrc`
 * view, which berry doesn't read:
 * - `npmRegistryServer` (default `https://registry.yarnpkg.com`), and each
 *   `npmScopes.<scope>.npmRegistryServer`;
 * - credentials by berry's own rule (`berryAuth`, applied by
 *   `berryAuthorizationFor`);
 * - `httpsCaFilePath`, `enableStrictSsl`, `httpProxy` / `httpsProxy` (no
 *   proxy from the environment, r27), `httpTimeout`, `httpRetry` and
 *   `networkConcurrency` for the client;
 * - a route berry refuses is `unusable`: a value that isn't an http(s) URL,
 *   or an `http:` registry whose host `unsafeHttpWhitelist` doesn't list.
 * Not read: `networkSettings`, `httpsKeyFilePath` / `httpsCertFilePath`,
 * and plugins' authentication hooks. `npmMinimalAgeGate` and `npmPreapprovedPackages` become `releaseAgeGate` (#166).
 */
export const berryRegistryConfig = (
  cwd: string,
  sources: NpmrcSources,
): RegistryConfig => {
  const settings = berrySettings(cwd, sources)
  const { scalars } = settings
  const unusable: UnusableRegistries = { scopes: {} }

  const problemOf = (value: string): string | undefined => {
    const problem = registryProblem(value)
    if (problem) return problem
    const url = new URL(value)
    if (
      url.protocol === 'http:' &&
      !settings.unsafeHttpWhitelist.some((glob) =>
        hostMatches(glob, url.hostname),
      )
    ) {
      return 'yarn refuses http registries unsafeHttpWhitelist does not list'
    }
    return undefined
  }

  let registry = DEFAULT_BERRY_REGISTRY
  const server = scalars.npmRegistryServer
  if (server) {
    const problem = problemOf(server.value)
    if (problem === undefined) registry = server.value
    else unusable.registry = unusableEntry({ ...server, reason: problem })
  }

  const scopedRegistries: Record<string, string> = {}
  const scopes: Record<string, BerryAuthEntry> = {}
  for (const [name, entry] of Object.entries(settings.scopes)) {
    const scope = `@${name}`
    scopes[scope] = authEntry(entry)
    const route = entry.npmRegistryServer
    if (!route) continue
    const problem = problemOf(route.value)
    if (problem === undefined) scopedRegistries[scope] = route.value
    else unusable.scopes[scope] = unusableEntry({ ...route, reason: problem })
  }

  const registries: Record<string, BerryAuthEntry> = {}
  for (const [key, entry] of Object.entries(settings.registries)) {
    registries[key] = authEntry(entry)
  }
  const berryAuth: BerryAuth = { top: authEntry(scalars), scopes, registries }

  // Every scope with an npmScopes entry has its own gate, one day unless
  // set, whatever the top level says (4.18.1's `Wxe`; probed 2026-11-03).
  const gateOf = (found: Sourced<string> | undefined): number =>
    berryDuration(found?.value, 'm') ?? DEFAULT_BERRY_AGE_GATE_MINUTES
  const releaseAgeGate: ReleaseAgeGate = {
    setting: 'npmMinimalAgeGate',
    minutes: gateOf(scalars.npmMinimalAgeGate),
    scopes: Object.fromEntries(
      Object.entries(settings.scopes).map(([name, entry]) => [
        `@${name}`,
        gateOf(entry.npmMinimalAgeGate),
      ]),
    ),
    // A descriptor or name glob, micromatch's `*` within a segment (`Tvt`).
    exempt: settings.npmPreapprovedPackages.map((pattern) =>
      exemptionOf(pattern, 'segment'),
    ),
    missingTime: 'held',
  }

  let ca: string[] | undefined
  const caFile = scalars.httpsCaFilePath
  if (caFile) {
    const file =
      caFile.source === 'the environment'
        ? path.resolve(cwd, caFile.value)
        : path.resolve(path.dirname(caFile.source), caFile.value)
    try {
      const certs = fs
        .readFileSync(file, 'utf8')
        .replace(/\r\n/g, '\n')
        .split(CERT_END)
        .filter((part) => part.trim())
        .map((part) => part.trimStart() + CERT_END)
      if (certs.length > 0) ca = certs
    } catch (error) {
      logger.debug(
        `Could not read httpsCaFilePath ${file}: ${(error as Error).message}`,
      )
    }
  }

  const proxy: RegistryConfig['proxy'] = {}
  if (scalars.httpsProxy?.value) proxy.HTTPS_PROXY = scalars.httpsProxy.value
  if (scalars.httpProxy?.value) proxy.HTTP_PROXY = scalars.httpProxy.value

  return withUnusable(
    {
      registry,
      scopedRegistries,
      credentials: {},
      berryAuth,
      releaseAgeGate,
      ...(ca ? { ca } : {}),
      strictSSL: berryBoolean(scalars.enableStrictSsl?.value) ?? true,
      proxy,
      fetchRetries: wholeAtLeast(scalars.httpRetry?.value, 0, 3),
      fetchTimeout: Math.round(
        berryDuration(scalars.httpTimeout?.value, 'ms') ?? 60_000,
      ),
      maxSockets: wholeAtLeast(scalars.networkConcurrency?.value, 1, 50),
    },
    unusable,
  )
}
