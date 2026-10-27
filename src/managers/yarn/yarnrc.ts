import path from 'path'

import type { RegistryConfig, UnusableRegistries } from '@/types'
import { ancestorFiles } from '@/utils/ancestors'
import {
  layerOrigin,
  type NpmrcSources,
  type NpmrcView,
  registryProblem,
  unusableEntry,
  withUnusable,
} from '@/utils/npmrcLoader'
import { readTextFile } from '@/utils/saveStyle'

/** What one .yarnrc routes, as written. */
export interface YarnrcRoutes {
  /** `registry "…"`: an ordinary setting, below .npmrc. */
  registry?: string
  /** `--registry "…"`: yarn applies it as a command-line flag, above everything. */
  flagRegistry?: string
  /** `--upgrade.registry "…"`: the same flag for `yarn upgrade` only, above `--registry`. */
  upgradeRegistry?: string
  /** '@scope' → registry URL, from `"@scope:registry" "…"` */
  scopes: Record<string, string>
}

// yarn v1 parses .yarnrc with its lockfile syntax. One top-level line is one
// or more keys (comma separated), an optional colon, an optional value and an
// optional `#` comment, separated by spaces only. A word is double-quoted
// (JSON), or bare: it starts with a letter, `/`, `.` or `-` and ends at `:`, a
// space or `,`, so a key holding `:` or `@` (a scope) and a URL value must be
// quoted. A value may also be a number.
const QUOTED = /"(?:[^"\\]|\\.)*"/y
const BARE = /[A-Za-z/.-][^: ,]*/y
const NUMBER = /[0-9]+/y

const wordAt = (
  line: string,
  pos: number,
  number: boolean,
): { value: string; end: number } | undefined => {
  for (const pattern of number ? [QUOTED, NUMBER, BARE] : [QUOTED, BARE]) {
    pattern.lastIndex = pos
    const found = pattern.exec(line)
    if (!found) continue
    if (pattern !== QUOTED) return { value: found[0], end: pattern.lastIndex }
    try {
      const value: unknown = JSON.parse(found[0])
      return typeof value === 'string'
        ? { value, end: pattern.lastIndex }
        : undefined
    } catch {
      return undefined
    }
  }
  return undefined
}

const skipSpaces = (line: string, pos: number): number => {
  while (line[pos] === ' ') pos++
  return pos
}

/** `[keys, value]` of one line, or undefined when yarn's parser rejects it. */
const scanLine = (line: string): [string[], string | undefined] | undefined => {
  const keys: string[] = []
  let pos = 0
  for (;;) {
    const key = wordAt(line, pos, false)
    if (!key) return undefined
    keys.push(key.value)
    pos = skipSpaces(line, key.end)
    if (line[pos] !== ',') break
    pos = skipSpaces(line, pos + 1)
  }
  const colon = line[pos] === ':'
  if (colon) pos = skipSpaces(line, pos + 1)

  let value: string | undefined
  if (pos < line.length && line[pos] !== '#') {
    const word = wordAt(line, pos, true)
    if (!word) return undefined
    value = word.value
    pos = skipSpaces(line, word.end)
  }
  if (pos < line.length && line[pos] !== '#') return undefined
  // A key with neither a colon nor a value is an error; `key:` is an empty object.
  return value === undefined && !colon ? undefined : [keys, value]
}

/**
 * The key-value pairs of a .yarnrc, a repeated key taking its last line.
 * Checked on yarn 1.22.22, 2026-10-26 with `yarn config get`:
 * - a leading BOM is dropped;
 * - a line starting with two (or any even number of) spaces is an indent: yarn
 *   stops there and keeps the keys before it. A first line's spaces are skipped;
 * - an odd indent, a tab, single quotes, an unquoted URL or scope key, or
 *   anything else yarn's parser rejects makes yarn fall back to YAML, which
 *   reads such a file as nothing (or fails). Read as empty here, YAML-style
 *   files (`registry: https://x/`) included.
 */
export const parseYarnrc = (text: string): Record<string, string> => {
  const entries: Record<string, string> = Object.create(null)
  const lines = text.replace(/^﻿/, '').split(/\r?\n/)
  for (const [index, raw] of lines.entries()) {
    let line = raw
    if (index === 0) line = line.replace(/^ +/, '')
    else if (line.startsWith(' ')) {
      const spaces = /^ */.exec(line)?.[0].length ?? 0
      return spaces % 2 === 0 ? entries : Object.create(null)
    }
    if (line === '' || line.startsWith('#')) continue
    const found = scanLine(line)
    if (!found) return Object.create(null)
    const [keys, value] = found
    if (value !== undefined) for (const key of keys) entries[key] = value
  }
  return entries
}

/** The registry values in one .yarnrc as written, usable or not. */
export const yarnrcRoutes = (text: string): YarnrcRoutes => {
  const entries = parseYarnrc(text)
  const scopes: Record<string, string> = {}
  for (const key of Object.keys(entries)) {
    const scope = /^(@[^:]+):registry$/.exec(key)?.[1]
    if (scope) scopes[scope] = entries[key]
  }
  return {
    registry: entries.registry,
    flagRegistry: entries['--registry'],
    upgradeRegistry: entries['--upgrade.registry'],
    scopes,
  }
}

/**
 * A registry value from the variable `name`, matched as the .npmrc layers
 * match `npm_config_*`: any case, empty values skipped, the last match
 * winning. Usable or not: yarn fails on one it cannot use.
 */
const envRegistry = (
  env: NodeJS.ProcessEnv,
  name: string,
): string | undefined => {
  let found: string | undefined
  for (const [key, value] of Object.entries(env)) {
    if (value?.trim() && key.toLowerCase() === name) found = value
  }
  return found
}

/**
 * The registry config yarn v1 resolves, over the .npmrc view `base`. Verified
 * on yarn 1.22.22, 2026-10-26, with `yarn install` / `yarn upgrade` against
 * local registries that log each request:
 * - the default registry: `--upgrade.registry` in a .yarnrc (`yarn upgrade`
 *   only; `--<other command>.registry` is ignored), then `--registry`, then
 *   `npm_config_registry`, then `YARN_REGISTRY`, then `registry=` in .npmrc,
 *   then `registry` in a .yarnrc, then the default (`base`);
 * - a scope: `npm_config_@scope:registry` / .npmrc `@scope:registry`, then
 *   `"@scope:registry"` in a .yarnrc, then the default registry. A scope beats
 *   every default, the flags included;
 * - among .yarnrc files, an ordinary key is read from the project directory
 *   (the workspace member when run from one), then `~/.yarnrc`, then the
 *   parent directories, nearest first, but not the filesystem root. The flags
 *   take `~/.yarnrc` first, then the project directory and its parents, the
 *   root's file included;
 * - credentials: a .yarnrc entry (`"//host/:_authToken"`, `_authToken`) sends
 *   nothing, so they stay with .npmrc, matched to the host the request lands
 *   on.
 * `npmrc` is the view of yarn's own .npmrc layers (`yarnNpmrcLayers`: the
 * cwd's, `~/.npmrc`, the prefix file, then the parents'), so a member's file
 * and a parent's are already in `base`.
 * Not read: `YARN_@SCOPE:REGISTRY` variables; for ordinary keys,
 * `${PREFIX or dirname(execPath)}/etc/yarnrc` (between `~/.yarnrc` and the
 * parents); and for the flags, `/etc/yarnrc`, `/etc/yarn/config`,
 * `~/.config/yarn/config` and `~/.yarn/config` (above the project).
 */
export const yarnRegistryConfig = (
  cwd: string,
  base: RegistryConfig,
  sources: NpmrcSources,
  npmrc: NpmrcView,
): RegistryConfig => {
  const { env, home } = sources
  const project = ancestorFiles(cwd, '.yarnrc')
  const user = path.join(home, '.yarnrc')

  // Each file is read and parsed once, whichever list it is in.
  const cache = new Map<string, YarnrcRoutes>()
  const route = (file: string): [YarnrcRoutes, string] => {
    let routes = cache.get(file)
    if (!routes) {
      routes = yarnrcRoutes(readTextFile(file))
      cache.set(file, routes)
    }
    return [routes, file]
  }

  // yarn reads the cwd, then ~/.yarnrc, then the parents without the root.
  const ordinary = [project[0], user, ...project.slice(1, -1)].map(route)
  const flags = [user, ...project].map(route)

  interface Candidate {
    key: string
    value: string
    source: string
  }
  const fromFiles = (
    files: [YarnrcRoutes, string][],
    key: string,
    pick: (routes: YarnrcRoutes) => string | undefined,
  ): Candidate | undefined => {
    for (const [routes, source] of files) {
      const value = pick(routes)
      if (value !== undefined && value.trim() !== '')
        return { key, value, source }
    }
    return undefined
  }

  const yarnEnv = envRegistry(env, 'yarn_registry')
  // `base` cannot say whether .npmrc set `registry` or the default stands, and
  // a .npmrc registry ranks above a .yarnrc one; the view says which layer set
  // it. An empty value counts as unset (m1: yarn goes on to .yarnrc).
  const set = npmrc.values.registry
  const npmrcSet =
    typeof set === 'string' && set.trim() !== '' ? set : undefined
  const npmrcLayer = npmrc.origin('registry')
  const npmrcCandidate: Candidate | undefined =
    npmrcSet === undefined
      ? undefined
      : { value: npmrcSet, ...layerOrigin(npmrcLayer, 'registry') }
  const fromEnv = npmrcLayer?.kind === 'env'

  // The first source that sets the default registry wins, usable or not:
  // yarn fails on a value it cannot use rather than asking the next source.
  const winner =
    fromFiles(flags, '--upgrade.registry', (r) => r.upgradeRegistry) ??
    fromFiles(flags, '--registry', (r) => r.flagRegistry) ??
    (fromEnv ? npmrcCandidate : undefined) ??
    (yarnEnv === undefined
      ? undefined
      : { key: 'YARN_REGISTRY', value: yarnEnv, source: 'the environment' }) ??
    (fromEnv ? undefined : npmrcCandidate) ??
    fromFiles(ordinary, 'registry', (r) => r.registry)

  const unusable: UnusableRegistries = {
    scopes: { ...base.unusable?.scopes },
  }
  let registry = base.registry
  if (winner) {
    const problem = registryProblem(winner.value)
    if (problem === undefined) registry = winner.value
    else {
      unusable.registry = unusableEntry({ ...winner, reason: problem })
    }
  }

  // A scope: .npmrc or the environment (already in `base`, usable or not),
  // else the nearest .yarnrc that names it.
  const scopedRegistries: Record<string, string> = { ...base.scopedRegistries }
  const fromYarnrc = new Map<string, Candidate>()
  for (const [routes, source] of [...ordinary].reverse()) {
    for (const [scope, value] of Object.entries(routes.scopes)) {
      if (value.trim() !== '') {
        fromYarnrc.set(scope, { key: `${scope}:registry`, value, source })
      }
    }
  }
  for (const [scope, found] of fromYarnrc) {
    if (scopedRegistries[scope] || unusable.scopes[scope]) continue
    const problem = registryProblem(found.value)
    if (problem === undefined) scopedRegistries[scope] = found.value
    else {
      unusable.scopes[scope] = unusableEntry({ ...found, reason: problem })
    }
  }

  return withUnusable({ ...base, registry, scopedRegistries }, unusable)
}
