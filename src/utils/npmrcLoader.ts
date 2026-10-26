import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  readManifest,
  readWorkspaceManifests,
  toPosix,
  workspacePatterns,
} from '@/managers/workspaces'
import type { RegistryConfig } from '@/types'
import { type Npmrc, parseNpmrc, substituteEnv } from './npmrc'

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

const boolValue = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value
  if (value === 'true') return true
  if (value === 'false') return false
  return undefined
}

const stripTrailingSlash = (url: string): string =>
  url.endsWith('/') ? url.slice(0, -1) : url

const hostFromAuthKey = (key: string): string | undefined => {
  // Auth keys look like "//registry.npmjs.org/:_authToken" or
  // "//registry.npmjs.org/some/path/:_authToken". Strip the
  // leading "//" and trailing ":_authToken" to get the host+path.
  const match = key.match(/^\/\/(.+):_authToken$/)
  return match ? match[1] : undefined
}

/** `npm_config_*` variables as npm reads them: any case, empty values skipped. */
const envConfig = (env: NodeJS.ProcessEnv): Npmrc => {
  const layer: Npmrc = Object.create(null)
  for (const [name, value] of Object.entries(env)) {
    if (!value || !/^npm_config_/i.test(name)) continue
    const rest = name.slice('npm_config_'.length)
    const key = rest.startsWith('//')
      ? rest
      : rest.replace(/(?!^)_/g, '-').toLowerCase()
    layer[key] = substituteEnv(value, env)
  }
  return layer
}

const readNpmrc = (filePath: string, env: NodeJS.ProcessEnv): Npmrc => {
  try {
    return parseNpmrc(fs.readFileSync(filePath, 'utf8'), env)
  } catch {
    return Object.create(null)
  }
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
const findNpmProjectRoot = (cwd: string): string => {
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
        const members = readWorkspaceManifests(dir, patterns)
        if (members.some((manifest) => manifest.path === member)) return dir
      }
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }

  return localPrefix ?? path.resolve(cwd)
}

/**
 * The merged .npmrc settings, as npm resolves them. Precedence (high → low):
 * `npm_config_*` environment variables → the project's .npmrc → the user's
 * (`~/.npmrc`) → the global one (`<prefix>/etc/npmrc`).
 */
export const loadNpmrc = (
  cwd: string,
  sources: NpmrcSources = processSources(),
): Npmrc => {
  const { env, home, execPath, platform } = sources
  const envLayer = envConfig(env)

  const userconfigOf = (layer: Npmrc): string =>
    resolveNpmPath(
      stringValue(envLayer.userconfig) ??
        stringValue(layer.userconfig) ??
        '~/.npmrc',
      home,
      cwd,
      platform,
    )

  const projectFile = path.join(findNpmProjectRoot(cwd), '.npmrc')
  const project: Npmrc =
    projectFile === userconfigOf(Object.create(null))
      ? Object.create(null)
      : readNpmrc(projectFile, env)

  const user = readNpmrc(userconfigOf(project), env)

  const prefix =
    env.PREFIX ??
    (platform === 'win32'
      ? path.dirname(execPath)
      : path.dirname(path.dirname(execPath)))
  const globalconfig = resolveNpmPath(
    stringValue(envLayer.globalconfig) ??
      stringValue(project.globalconfig) ??
      stringValue(user.globalconfig) ??
      path.join(prefix, 'etc', 'npmrc'),
    home,
    cwd,
    platform,
  )

  return Object.assign(
    Object.create(null),
    readNpmrc(globalconfig, env),
    user,
    project,
    envLayer,
  )
}

/** A boolean .npmrc value (`true` / `false`, as a string or a boolean). */
export const npmrcBoolean = (value: unknown): boolean | undefined =>
  boolValue(value)

/**
 * Loads .npmrc-style config the way npm/pnpm/yarn-classic/bun do for the
 * registry/auth fields we care about (see `loadNpmrc` for precedence). Yarn
 * berry's .yarnrc.yml and Bun's bunfig.toml are not yet read.
 */
export const loadRegistryConfig = (
  cwd: string,
  sources: NpmrcSources = processSources(),
): RegistryConfig => {
  const merged = loadNpmrc(cwd, sources)

  const registry = stringValue(merged.registry) ?? 'https://registry.npmjs.org/'

  const scopedRegistries: Record<string, string> = {}
  const authTokens: Record<string, string> = {}

  for (const [key, value] of Object.entries(merged)) {
    if (typeof value !== 'string') continue

    if (/^@[^:]+:registry$/.test(key)) {
      const scope = key.slice(0, key.indexOf(':'))
      scopedRegistries[scope] = value
      continue
    }

    if (key.startsWith('//') && key.endsWith(':_authToken')) {
      const host = hostFromAuthKey(key)
      if (host) authTokens[stripTrailingSlash(host)] = value
    }
  }

  return {
    registry,
    scopedRegistries,
    authTokens,
    alwaysAuth: boolValue(merged['always-auth']),
    strictSSL: boolValue(merged['strict-ssl']),
    ca: stringValue(merged.ca),
    cafile: stringValue(merged.cafile),
  }
}
