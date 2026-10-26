import path from 'path'

import type { RegistryConfig } from '@/types'
import {
  isRegistryUrl,
  loadNpmrc,
  type NpmrcSources,
  nonEmpty,
} from '@/utils/npmrcLoader'
import { readTextFile } from '@/utils/saveStyle'

/** What one .yarnrc routes. */
export interface YarnrcRoutes {
  /** `registry "…"`: an ordinary setting, below .npmrc. */
  registry?: string
  /** `--registry "…"`: yarn applies it as a command-line flag, above everything. */
  flagRegistry?: string
  /** '@scope' → registry URL, from `"@scope:registry" "…"` */
  scopes: Record<string, string>
}

// One top-level line of yarn's lockfile syntax, which yarn v1 parses .yarnrc
// with: a bare or double-quoted key, an optional colon, a bare or
// double-quoted value, an optional `#` comment. A bare word starts with a
// letter, `/`, `.` or `-` and ends at `:`, a space or `,`, so a key holding
// `:` or `@` (a scope) must be quoted, and a URL value must be quoted too.
const STRING = '"((?:[^"\\\\]|\\\\.)*)"'
const BARE = '([A-Za-z/.-][^:\\s,]*)'
const LINE = new RegExp(
  `^(?:${STRING}|${BARE})\\s*:?\\s*(?:${STRING}|${BARE})\\s*(?:#.*)?$`,
)

const quoted = (inner: string): string | undefined => {
  try {
    const value: unknown = JSON.parse(`"${inner}"`)
    return typeof value === 'string' ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * The key-value pairs of a .yarnrc, the last of a repeated key winning. A
 * line yarn cannot parse is skipped here; yarn itself fails the command on it,
 * or, when the whole file is valid YAML (`registry: https://x/`), reads the
 * file as YAML, which this does not.
 */
export const parseYarnrc = (text: string): Record<string, string> => {
  const entries: Record<string, string> = Object.create(null)
  for (const line of text.split(/\r?\n/)) {
    const found = LINE.exec(line)
    if (!found) continue
    const key = found[1] === undefined ? found[2] : quoted(found[1])
    const value = found[3] === undefined ? found[4] : quoted(found[3])
    if (key !== undefined && value !== undefined) entries[key] = value
  }
  return entries
}

/** The registry routes in one .yarnrc. A value that is not an http(s) URL is skipped. */
export const yarnrcRoutes = (text: string): YarnrcRoutes => {
  const entries = parseYarnrc(text)
  const url = (key: string): string | undefined =>
    entries[key] !== undefined && isRegistryUrl(entries[key])
      ? entries[key]
      : undefined

  const scopes: Record<string, string> = {}
  for (const key of Object.keys(entries)) {
    const scope = /^(@[^:]+):registry$/.exec(key)?.[1]
    const value = url(key)
    if (scope && value) scopes[scope] = value
  }
  return { registry: url('registry'), flagRegistry: url('--registry'), scopes }
}

/** The .yarnrc files yarn reads from `cwd` upward, nearest first. */
const ancestorFiles = (cwd: string): string[] => {
  const files: string[] = []
  let dir = path.resolve(cwd)
  for (;;) {
    files.push(path.join(dir, '.yarnrc'))
    const parent = path.dirname(dir)
    if (parent === dir) return files
    dir = parent
  }
}

const firstDefined = <T>(values: (T | undefined)[]): T | undefined =>
  values.find((value) => value !== undefined)

const envValue = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const key = Object.keys(env).find((k) => k.toLowerCase() === name)
  const value = key === undefined ? undefined : nonEmpty(env[key])
  return value !== undefined && isRegistryUrl(value) ? value : undefined
}

/**
 * The registry config yarn v1 resolves, over the .npmrc view `base`. Verified
 * on yarn 1.22.22, 2026-10-26, with `yarn install` against local registries:
 * - the default registry: `--registry` in a .yarnrc, then `npm_config_registry`,
 *   then `YARN_REGISTRY`, then `registry=` in .npmrc, then `registry` in a
 *   .yarnrc, then the default (`base`);
 * - a scope: `npm_config_@scope:registry` / .npmrc `@scope:registry`, then
 *   `"@scope:registry"` in a .yarnrc, then the default registry. A scope beats
 *   every default, `--registry` included;
 * - among .yarnrc files, an ordinary key is read from the project directory
 *   (the workspace member when run from one), then `~/.yarnrc`, then the
 *   parent directories, nearest first, up to the filesystem root; `--registry`
 *   takes `~/.yarnrc` first, then the project directory and its parents;
 * - credentials: a .yarnrc entry (`"//host/:_authToken"`, `_authToken`) sends
 *   nothing, so they stay with .npmrc, matched to the host the request lands
 *   on.
 * Not read: `/etc/yarnrc`, `YARN_@SCOPE:REGISTRY` variables, and .npmrc files
 * of a workspace member (autd reads the root's; yarn reads the member's, then
 * `~/.npmrc`, then the root's).
 */
export const yarnRegistryConfig = (
  cwd: string,
  base: RegistryConfig,
  sources: NpmrcSources,
): RegistryConfig => {
  const { env, home } = sources
  const project = ancestorFiles(cwd)
  const user = path.join(home, '.yarnrc')
  const route = (file: string): YarnrcRoutes => yarnrcRoutes(readTextFile(file))

  // `cwd` first, then the user's file, then the parents.
  const ordinary = [project[0], user, ...project.slice(1)].map(route)
  const flags = [user, ...project].map(route)

  const npmrcRegistry = nonEmpty(loadNpmrc(cwd, sources).registry)
  const fromNpm =
    envValue(env, 'npm_config_registry') !== undefined ||
    (npmrcRegistry !== undefined && isRegistryUrl(npmrcRegistry))
  const yarnEnv = envValue(env, 'yarn_registry')

  const registry =
    firstDefined(flags.map((r) => r.flagRegistry)) ??
    (envValue(env, 'npm_config_registry') !== undefined
      ? base.registry
      : null) ??
    yarnEnv ??
    (fromNpm ? base.registry : null) ??
    firstDefined(ordinary.map((r) => r.registry)) ??
    base.registry

  const scopedRegistries: Record<string, string> = {}
  for (const routes of [...ordinary].reverse()) {
    Object.assign(scopedRegistries, routes.scopes)
  }
  Object.assign(scopedRegistries, base.scopedRegistries)

  return { ...base, registry, scopedRegistries }
}
