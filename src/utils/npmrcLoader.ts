import { execFileSync } from 'child_process'
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
import { StepError } from '@/stepError'
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
  /**
   * The node npm and yarn v1 run under, whose install is their default
   * prefix; undefined when there is none (`npmNodeExecPath`, #269).
   */
  execPath: string | undefined
  platform: NodeJS.Platform
}

/** cmd.exe's exit status for a command it can't find. */
const CMD_NOT_FOUND = 9009

/**
 * Whether a `node` cmd.exe would run is on PATH: a file named `node` plus one
 * of PATHEXT's extensions in one of PATH's directories. Under Bun, cmd.exe's
 * "not recognized" doesn't come back as status 9009 (#266's Windows CI, with
 * an empty PATH), and its message is localized, so the lookup decides.
 */
const nodeOnWindowsPath = (env: NodeJS.ProcessEnv): boolean => {
  const dirs = (env.PATH ?? env.Path ?? '')
    .split(path.win32.delimiter)
    .filter(Boolean)
  const extensions = (env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(path.win32.delimiter)
    .filter(Boolean)
  return dirs.some((dir) =>
    extensions.some((extension) =>
      fs.existsSync(path.join(dir, `node${extension.toLowerCase()}`)),
    ),
  )
}

/**
 * Asks the `node` npm would run in `cwd` (its `#!/usr/bin/env node`, or
 * npm.cmd's `node`) for its own `process.execPath`. A version manager's shim
 * (asdf, volta, mise) picks the version by directory and only resolves by
 * running it, so the probe runs where autd runs the manager. On Windows it
 * goes through cmd.exe, which a `.cmd` shim needs, once PATH holds a `node`;
 * the command is a fixed string. Undefined when there is no `node`; any other
 * failure is a `discover` StepError, since a global `.npmrc` read from the
 * wrong place can drop a manager's release-age gate.
 *
 * Synchronous, unlike `runProcess`, because `registryConfig()` is: it runs
 * once per directory, only under Bun.
 */
const probeNodeExecPath = (
  cwd: string,
  platform: NodeJS.Platform = process.platform,
): string | undefined => {
  if (platform === 'win32' && !nodeOnWindowsPath(process.env)) {
    return undefined
  }
  const options = {
    cwd,
    encoding: 'utf8' as const,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'] as ['ignore', 'pipe', 'pipe'],
    timeout: 30_000,
    windowsHide: true,
  }
  try {
    const printed = (
      platform === 'win32'
        ? execFileSync('node -p process.execPath', { ...options, shell: true })
        : execFileSync('node', ['-p', 'process.execPath'], options)
    ).trim()
    if (printed === '') throw new Error('it printed nothing')
    return printed
  } catch (error) {
    const { code, status } = error as NodeJS.ErrnoException & {
      status?: number | null
    }
    if (
      code === 'ENOENT' ||
      (platform === 'win32' && status === CMD_NOT_FOUND)
    ) {
      return undefined
    }
    throw new StepError(
      'discover',
      `couldn't ask node for its path, which npm's global .npmrc is found from: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    )
  }
}

// Per directory, once per run; a failure is kept too, so node isn't started again.
const probedNode = new Map<
  string,
  { ok: true; execPath: string | undefined } | { ok: false; error: unknown }
>()

const probeNodeOnce = (cwd: string): string | undefined => {
  let result = probedNode.get(cwd)
  if (!result) {
    try {
      result = { ok: true, execPath: probeNodeExecPath(cwd) }
    } catch (error) {
      result = { ok: false, error }
    }
    probedNode.set(cwd, result)
  }
  if (!result.ok) throw result.error
  return result.execPath
}

/**
 * The node npm runs under in `cwd` (#269). Under Node it is this process's
 * own `process.execPath`, as before. Under Bun (the compiled binary)
 * `process.execPath` is autd itself, so the `node` npm would run there is
 * asked (`probe`, injectable for tests).
 */
export const npmNodeExecPath = ({
  cwd = process.cwd(),
  versions = process.versions,
  execPath = process.execPath,
  probe = probeNodeOnce,
}: {
  cwd?: string
  versions?: { node?: string; bun?: string }
  execPath?: string
  probe?: (cwd: string) => string | undefined
} = {}): string | undefined => (versions.bun ? probe(cwd) : execPath)

/**
 * The machine's sources for the manager's settings at `cwd`, where autd runs
 * the manager (the project root, #127).
 */
export const processSources = (cwd: string = process.cwd()): NpmrcSources => ({
  env: process.env,
  home: process.env.HOME || os.homedir(),
  // A getter: under Bun, finding node starts it, so only a reader of npm's or
  // yarn v1's prefix pays for it (#269). Nothing in src spreads the sources;
  // a spread would read it, and start node, at once.
  get execPath() {
    return npmNodeExecPath({ cwd })
  },
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
 * from the node npm runs under (`NpmrcSources.execPath`); undefined with no
 * node. DESTDIR (npm prefixes the default prefix with it on posix) is not
 * supported.
 */
export const execPrefix = ({
  execPath,
  platform,
}: NpmrcSources): string | undefined => {
  if (execPath === undefined) return undefined
  return platform === 'win32'
    ? path.dirname(execPath)
    : path.dirname(path.dirname(execPath))
}

/**
 * npm's layers, highest first: `npm_config_*` environment variables → the
 * project's .npmrc (the nearest npm project root's) → the user's
 * (`~/.npmrc`) → the global one (`<prefix>/etc/npmrc`) → npm's builtin one.
 */
export const npmNpmrcLayers = (
  cwd: string,
  sources: NpmrcSources = processSources(cwd),
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

  // With no node to run npm under, there is no builtin file and no default
  // prefix (#269); PREFIX, `prefix` and `globalconfig` still name the global one.
  const prefixDir = execPrefix(sources)
  const builtin =
    prefixDir === undefined
      ? undefined
      : npmrcFileLayer(
          platform === 'win32'
            ? path.join(prefixDir, 'node_modules', 'npm', 'npmrc')
            : path.join(prefixDir, 'lib', 'node_modules', 'npm', 'npmrc'),
          env,
        )

  const layers = builtin
    ? [envL, project, user, builtin]
    : [envL, project, user]
  const pick = (key: string): string | undefined => {
    for (const layer of layers) {
      const value = stringValue(layer.values[key])
      if (value !== undefined) return value
    }
    return undefined
  }

  const prefixSetting = pick('prefix') ?? nonEmpty(env.PREFIX) ?? prefixDir
  const prefix =
    prefixSetting === undefined
      ? undefined
      : resolveNpmPath(prefixSetting, home, cwd, platform)
  const globalSetting =
    pick('globalconfig') ??
    (prefix === undefined ? undefined : path.resolve(prefix, 'etc/npmrc'))
  const globalLayer =
    globalSetting === undefined
      ? undefined
      : npmrcFileLayer(resolveNpmPath(globalSetting, home, cwd, platform), env)

  return [envL, project, user, globalLayer, builtin].filter(
    (layer): layer is NpmrcLayer => layer !== undefined,
  )
}

/** The merged .npmrc settings, as npm resolves them (see `npmNpmrcLayers`). */
export const loadNpmrc = (
  cwd: string,
  sources: NpmrcSources = processSources(cwd),
): Npmrc => mergeNpmrcLayers(npmNpmrcLayers(cwd, sources)).values

/**
 * Loads .npmrc-style config the way npm does for the registry fields we care
 * about (see `loadNpmrc` for precedence). Managers that route registries
 * elsewhere adjust the result through `ManagerAdapter.registryConfig`.
 */
export const loadRegistryConfig = (
  cwd: string,
  sources: NpmrcSources = processSources(cwd),
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
