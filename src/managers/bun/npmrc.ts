import fs from 'fs'
import path from 'path'

import { parseNpmrc } from '@/utils/npmrc'
import {
  findNpmProjectRoot,
  type NpmrcLayer,
  type NpmrcSources,
  nonEmpty,
} from '@/utils/npmrcLoader'

/**
 * A value as bun expands it (verified on bun 1.4.4, 2026-10-26: b30, b31,
 * rev r1, r4):
 * - `${VAR}` anywhere, and `${VAR?}`, which is '' when VAR is unset; any other
 *   unset variable stays literal, and bun sends it as written (autd treats a
 *   credential still holding `${…}` as absent instead, the one place it differs);
 * - `$VAR` only when it is the whole value (`pre$TOK` and `host:$PORT/` stay);
 * - backslashes before a `$` follow npm's rule: an odd run escapes it and
 *   loses half (one `\` + `${T}` gives the literal `${T}`), an even run loses
 *   half and the `$` stays active. The unescaped `\$TOK` of a whole value
 *   then expands like `$TOK`.
 */
export const substituteBun = (text: string, env: NodeJS.ProcessEnv): string => {
  const unescaped = text.replace(
    /(\\*)\$(?:\{([^${}?]+)(\?)?\}|([A-Za-z_][A-Za-z0-9_]*))/g,
    (original, slashes: string, name?: string, optional?: string) => {
      const escaped = slashes.length % 2 === 1
      const kept = slashes.slice(Math.ceil(slashes.length / 2))
      const dollar = original.slice(slashes.length)
      if (name === undefined || escaped) return kept + dollar
      return kept + (env[name] ?? (optional === '?' ? '' : dollar))
    },
  )
  const whole = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(unescaped)
  return whole ? (env[whole[1]] ?? unescaped) : unescaped
}

const QUOTED = /^(".*"|'.*')$/

/**
 * The text of an .npmrc value that bun expands: the raw line's text, because
 * bun counts backslashes as written while `parseNpmrc` collapses each pair
 * first (so two and three backslashes before `${T}` would look alike). A
 * quoted value is its decoded text; an unquoted one ends at the first
 * unescaped `;` or `#`, and `\;` and `\#` are unescaped, as the parser does.
 */
const valueText = (raw: string): string | undefined => {
  const value = raw.trim()
  if (QUOTED.test(value)) {
    const decoded = parseNpmrc(`v=${value}`, {}, null).v
    return typeof decoded === 'string' ? decoded : undefined
  }
  let result = ''
  for (let i = 0; i < value.length; i++) {
    const char = value[i]
    if (char === '\\' && (value[i + 1] === ';' || value[i + 1] === '#')) {
      result += value[++i]
    } else if (char === '\\') {
      result += char + (value[++i] ?? '')
    } else if (char === ';' || char === '#') {
      break
    } else {
      result += char
    }
  }
  return result.trim()
}

/**
 * The file's text with every `key=value` value expanded as bun does and
 * written back as a JSON string, which `parseNpmrc` decodes unchanged (a
 * secret holding `;` or `#` survives). Keys are left as written: bun
 * expands values only (rev r3).
 */
const expandValues = (text: string, env: NodeJS.ProcessEnv): string =>
  text
    .split(/[\r\n]+/)
    .map((line) => {
      if (/^\s*[;#]/.test(line) || /^\[[^\]]*\]\s*$/.test(line)) return line
      const equals = line.indexOf('=')
      if (equals < 1) return line
      const value = valueText(line.slice(equals + 1))
      if (value === undefined) return line
      return `${line.slice(0, equals)}=${JSON.stringify(substituteBun(value, env))}`
    })
    .join('\n')

const readLayer = (file: string, env: NodeJS.ProcessEnv): NpmrcLayer => {
  try {
    const text = fs.readFileSync(file, 'utf8')
    return {
      kind: 'file',
      file,
      values: parseNpmrc(expandValues(text, env), env, null),
    }
  } catch {
    return { kind: 'file', file, values: Object.create(null) }
  }
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
