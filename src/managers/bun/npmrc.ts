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
 * `${VAR}` anywhere in a value, and `$VAR` only when it is the whole value
 * (`pre$TOK` and `http://host:$PORT/` stay as written). An unset variable
 * stays literal, and bun sends it that way. autd treats a credential still
 * holding `${…}` as absent instead (the one place it differs from bun).
 * Verified on bun 1.4.4, 2026-10-26 (b30, b30b-b30g, b31, b31c).
 */
export const substituteBun = (text: string, env: NodeJS.ProcessEnv): string => {
  const whole = /^\$([A-Za-z_][A-Za-z0-9_]*)$/.exec(text)
  if (whole) return env[whole[1]] ?? text
  return text.replace(
    /\$\{([^${}]+)\}/g,
    (original, name: string) => env[name] ?? original,
  )
}

/** Whether anything, a directory included, sits at `file`. */
const exists = (file: string): boolean => {
  try {
    fs.lstatSync(file)
    return true
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
 */
export const bunNpmrcLayers = (
  cwd: string,
  sources: NpmrcSources,
): NpmrcLayer[] => {
  const { env } = sources
  const options = { substitute: substituteBun }
  return [
    npmrcFileLayer(path.join(findNpmProjectRoot(cwd), '.npmrc'), env, options),
    npmrcFileLayer(bunUserNpmrc(cwd, sources), env, options),
  ]
}
