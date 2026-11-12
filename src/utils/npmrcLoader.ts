import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ManagerAdapter } from '@/managers/adapter'
import {
  matchesWorkspacePatterns,
  readManifest,
  toPosix,
  workspacePatterns,
} from '@/managers/workspaces'
import type { RegistryConfig } from '@/types'
import {
  type Npmrc,
  type NpmrcValue,
  nonEmpty,
  parseNpmrc,
  resolveNpmPath,
  type Substitute,
  substituteEnv,
} from './npmrc'
import { registryConfigFrom } from './registryConfig'

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

/** One source of .npmrc settings; a missing or unreadable file is an empty layer. */
export type NpmrcLayer =
  | { kind: 'env'; values: Npmrc; labels?: Record<string, string> }
  | {
      kind: 'file'
      file: string
      values: Npmrc
      labels?: Record<string, string>
    }

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
  /**
   * Which of several variables that name the same key wins: the higher rank,
   * and the later in `env` among equals. Without it the later one wins.
   */
  rank?(name: string, key: string): number
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
  const labels: Record<string, string> = Object.create(null)
  const ranks = new Map<string, number>()
  for (const [name, value] of Object.entries(env)) {
    if (!value) continue
    const match = rule.prefix.exec(name)
    if (!match) continue
    const key = rule.key(name.slice(match[0].length), name)
    if (key === undefined) continue
    const rank = rule.rank?.(name, key) ?? 0
    if (rank < (ranks.get(key) ?? rank)) continue
    ranks.set(key, rank)
    values[key] = rule.substitute ? rule.substitute(value, env) : value
    labels[key] = name
  }
  return { kind: 'env', values, labels }
}

/** A key or value (or array element) still holding a `${…}` reference. */
const holdsReference = (key: string, value: NpmrcValue): boolean =>
  key.includes('${') ||
  (Array.isArray(value) ? value : [value]).some(
    (v) => typeof v === 'string' && v.includes('${'),
  )

/**
 * A file's settings as one layer. `substitute` defaults to npm's; null
 * expands nothing. With `omitReferences`, an entry whose key or value still
 * holds `${…}` is left out, so a lower layer decides (pnpm's project files).
 */
export const npmrcFileLayer = (
  file: string,
  env: NodeJS.ProcessEnv,
  {
    substitute = substituteEnv,
    omitReferences = false,
  }: { substitute?: Substitute | null; omitReferences?: boolean } = {},
): NpmrcLayer => {
  let values: Npmrc
  try {
    values = parseNpmrc(fs.readFileSync(file, 'utf8'), env, substitute)
  } catch {
    values = Object.create(null)
  }
  if (omitReferences) {
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

/**
 * Loads .npmrc-style config the way npm does for the registry fields we care
 * about (see `loadNpmrc` for precedence). Managers that route registries
 * elsewhere adjust the result through `ManagerAdapter.registryConfig`.
 */
export const loadRegistryConfig = (
  cwd: string,
  sources: NpmrcSources = processSources(),
): RegistryConfig => {
  const view = mergeNpmrcLayers(npmNpmrcLayers(cwd, sources))
  return registryConfigFrom(view, cwd, sources)
}

/**
 * The run's registry config for a manager: the merge of its `.npmrc` layers
 * (`npmrcLayers`, else npm's), then the manager's own `registryConfig` hook,
 * then its `releaseAgeGate`.
 * One place for the session's wiring, so tests exercise the real thing.
 */
export const managerRegistryConfig = (
  adapter: Pick<
    ManagerAdapter,
    'npmrcLayers' | 'registryConfig' | 'emptyRegistry' | 'releaseAgeGate'
  >,
  dir: string,
  sources: NpmrcSources,
): RegistryConfig => {
  const npmrc = mergeNpmrcLayers(
    (adapter.npmrcLayers ?? npmNpmrcLayers)(dir, sources),
  )
  const fromNpmrc = registryConfigFrom(
    npmrc,
    dir,
    sources,
    adapter.emptyRegistry,
  )
  const config =
    adapter.registryConfig?.(dir, fromNpmrc, sources, npmrc) ?? fromNpmrc
  // The manager's release-age gate (#168), from its own settings.
  const gate = adapter.releaseAgeGate?.(dir, sources, npmrc)
  return gate ? { ...config, releaseAgeGate: gate } : config
}
