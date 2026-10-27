import fs from 'fs'
import path from 'path'

import {
  findNpmProjectRoot,
  type NpmrcLayer,
  type NpmrcSources,
  nonEmpty,
  npmrcFileLayer,
} from '@/utils/npmrcLoader'

/**
 * A parsed value as bun expands it (verified on bun 1.4.4, 2026-10-26: b30,
 * b31, rev r1, r4):
 * - `${VAR}` anywhere, and `${VAR?}`, which is '' when VAR is unset; any other
 *   unset variable stays literal, and bun sends it as written (autd treats a
 *   credential still holding `${…}` as absent instead, the one place it differs);
 * - `$VAR` only when the parsed value as a whole is `$NAME` (`pre$TOK` and
 *   `host:$PORT/` stay), judged before any substitution, so a substituted
 *   `$…` value is never expanded again;
 * - an odd run of backslashes before a `$` escapes it and loses half (one
 *   `\` + `${T}` gives the literal `${T}`); an even run loses half and the `$`
 *   stays active.
 *
 * One difference: the values come from the shared parser, which has already
 * collapsed each `\\` pair, so two backslashes before `${T}` read as one and
 * give the literal where bun sends `\VAL` (and three read as two, four as two).
 */
export const substituteBun = (text: string, env: NodeJS.ProcessEnv): string => {
  const whole = /^\\?\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(text)
  if (whole) return env[whole[1]] ?? text.replace(/^\\/, '')
  return text.replace(
    /(\\*)\$(?:\{([^${}?]+)(\?)?\}|[A-Za-z_][A-Za-z0-9_]*)/g,
    (original, slashes: string, name?: string, optional?: string) => {
      const kept = slashes.slice(Math.ceil(slashes.length / 2))
      const dollar = original.slice(slashes.length)
      if (name === undefined || slashes.length % 2 === 1) return kept + dollar
      return kept + (env[name] ?? (optional === '?' ? '' : dollar))
    },
  )
}

/**
 * A file's parsed settings with the values expanded (strings and the strings
 * of an array; booleans and null stay). Keys stay as written: bun expands
 * values only (rev r3).
 */
const readLayer = (file: string, env: NodeJS.ProcessEnv): NpmrcLayer => {
  const layer = npmrcFileLayer(file, env, { substitute: null })
  for (const [key, value] of Object.entries(layer.values)) {
    if (typeof value === 'string') layer.values[key] = substituteBun(value, env)
    else if (Array.isArray(value)) {
      layer.values[key] = value.map((v) =>
        typeof v === 'string' ? substituteBun(v, env) : v,
      )
    }
  }
  return layer
}

/** Whether anything, a directory included, sits at `file` (a dangling symlink is nothing). */
const exists = (file: string): boolean => {
  try {
    // Follows links: bun skips a dangling symlink and reads ~/.npmrc.
    return fs.statSync(file, { throwIfNoEntry: false }) !== undefined
  } catch {
    return false
  }
}

/**
 * The one user file bun reads, verified on bun 1.4.4, 2026-10-26:
 * 1. `NPM_CONFIG_USERCONFIG`, else `npm_config_userconfig` (b22, b22k): a path
 *    against cwd with `~/` expanded (b22i, b22l); it replaces both files below,
 *    and a missing file means no user layer (b22f);
 * 2. `$XDG_CONFIG_HOME/.npmrc` when anything is there, an empty file or a
 *    directory included (b20, b20b), and only for an absolute XDG (b21);
 * 3. `~/.npmrc`.
 */
export const bunUserNpmrc = (
  cwd: string,
  { env, home }: NpmrcSources,
): string => {
  const configured =
    nonEmpty(env.NPM_CONFIG_USERCONFIG) ?? nonEmpty(env.npm_config_userconfig)
  if (configured !== undefined) {
    const expanded = /^~[\\/]/.test(configured)
      ? path.join(home, configured.slice(2))
      : configured
    return path.resolve(cwd, expanded)
  }
  const xdg = nonEmpty(env.XDG_CONFIG_HOME)
  if (xdg && path.isAbsolute(xdg)) {
    const file = path.join(xdg, '.npmrc')
    if (exists(file)) return file
  }
  return path.join(home, '.npmrc')
}

/**
 * bun's `.npmrc` layers, highest first: the project's (the workspace root's
 * from a member; no parent directory's, b33), then the one user file. There
 * is no environment layer (`npm_config_*` routes and credentials are not read,
 * b26, b27; the registry and token variables are `bunRegistryConfig`'s) and no
 * npm global or builtin file (b32).
 *
 * Not verified: on Windows bun probably takes its home from `USERPROFILE`,
 * not `HOME`; `sources.home` is used as is.
 */
export const bunNpmrcLayers = (
  cwd: string,
  sources: NpmrcSources,
): NpmrcLayer[] => {
  const { env } = sources
  const read = (file: string): NpmrcLayer => readLayer(file, env)
  return [
    read(path.join(findNpmProjectRoot(cwd), '.npmrc')),
    read(bunUserNpmrc(cwd, sources)),
  ]
}
