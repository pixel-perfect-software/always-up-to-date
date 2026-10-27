import fs from 'fs'
import path from 'path'

import {
  type PnpmRegistrySettings,
  pnpmRegistrySettings,
  substitutePnpm,
} from '@/managers/pnpm/registries'
import type { Npmrc } from '@/utils/npmrc'
import {
  type EnvRule,
  envLayer,
  type NpmrcLayer,
  type NpmrcSources,
  nonEmpty,
  npmrcFileLayer,
} from '@/utils/npmrcLoader'
import { readTextFile } from '@/utils/saveStyle'

/**
 * The directory pnpm reads its project settings from: the nearest one,
 * walking up from `cwd`, that holds a pnpm-workspace.yaml. From a member that
 * is the workspace root, and its yaml and .npmrc are the only project files
 * read (verified on pnpm 12.15.0, 2026-10-26: a member's own .npmrc is
 * ignored, and a member with a yaml of its own is its own root).
 */
export const pnpmProjectRoot = (cwd: string): string => {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    if (path.dirname(dir) === dir) return path.resolve(cwd)
  }
}

/**
 * pnpm's global config directory, which holds `config.yaml` and `auth.ini`.
 * `$XDG_CONFIG_HOME/pnpm` when set (a relative one against cwd, not HOME, with
 * no fallback), else `~/Library/Preferences/pnpm` on macOS (`~/.config/pnpm`
 * is not read there), else `~/.config/pnpm`; on Windows
 * `%LOCALAPPDATA%\pnpm\config` when set. macOS and the XDG forms were verified
 * on pnpm 12.15.0, 2026-10-26 (p50–p53). Linux was run in Docker (node:24, pnpm
 * 12.15.0, arm64): `~/.config/pnpm/auth.ini` and `config.yaml` are read,
 * `~/Library/Preferences/pnpm` and `rc` are not, and an XDG directory beats
 * `~/.config/pnpm`. Windows is read from pnpm's source at tag v12.15.0
 * (`getConfigDir`, config/reader/src/dirs.ts), not run. That source also expands `%VAR%` in a Windows path; autd does not.
 */
export const pnpmConfigDir = (
  cwd: string,
  { env, home, platform }: NpmrcSources,
): string => {
  const xdg = nonEmpty(env.XDG_CONFIG_HOME)
  if (xdg) return path.resolve(cwd, xdg, 'pnpm')
  if (platform === 'darwin') {
    return path.join(home, 'Library', 'Preferences', 'pnpm')
  }
  if (platform === 'win32') {
    const localAppData = nonEmpty(env.LOCALAPPDATA)
    if (localAppData) return path.join(localAppData, 'pnpm', 'config')
  }
  return path.join(home, '.config', 'pnpm')
}

/**
 * `pnpm_config_<lower_snake>` or `PNPM_CONFIG_<UPPER_SNAKE>`, nothing mixed:
 * `_` becomes `-` and camelCase is not read. A `//host/:…` key is kept as
 * written and is read under a prefix in any case (`Pnpm_Config_//…` too).
 * `@scope:registry` is not read from the environment. Values expand `${VAR}`
 * and `${VAR:-default}`. `userconfig` is left to `userFile`, which reads it
 * raw. With both casings set for one key, `PNPM_CONFIG_*` wins whatever the
 * order of the environment (rb1, rb2); two `//` credentials tie, and pnpm
 * takes the later one in the environment, as `envLayer` does (rb3, rb4).
 * Verified on pnpm 12.15.0 and 12.14.0, 2026-10-26 (p20–p22, p25, p26, rb, rc).
 */
export const PNPM_ENV: EnvRule = {
  prefix: /^pnpm_config_/i,
  key: (rest, name) => {
    if (rest.startsWith('//')) return rest
    const lower = name.startsWith('pnpm_config_')
    if (!lower && !name.startsWith('PNPM_CONFIG_')) return undefined
    if (!(lower ? /^[a-z0-9_]+$/ : /^[A-Z0-9_]+$/).test(rest)) return undefined
    const key = rest.toLowerCase().replace(/_/g, '-')
    return key === 'userconfig' ? undefined : key
  },
  rank: (name, key) =>
    !key.startsWith('//') && name.startsWith('PNPM_CONFIG_') ? 1 : 0,
  substitute: substitutePnpm,
}

/**
 * `npm_config_*` as pnpm reads it: the `//host/:…` credential keys only, under
 * a prefix in any case (`Npm_Config_//…` is read, rc1), values as written (no
 * expansion). Every other `npm_config_*` key, routes included, is ignored
 * (p21, p23). Two casings of one key: the later in the environment wins.
 */
const NPM_CREDENTIALS_ENV: EnvRule = {
  prefix: /^npm_config_/i,
  key: (rest) => (rest.startsWith('//') ? rest : undefined),
  substitute: null,
}

const routeLayer = (
  file: string,
  { registry, scopes }: PnpmRegistrySettings,
): NpmrcLayer => {
  const values: Npmrc = Object.create(null)
  if (registry !== undefined) values.registry = registry
  for (const [scope, url] of Object.entries(scopes)) {
    values[`${scope}:registry`] = url
  }
  return { kind: 'file', file, values }
}

/**
 * `pnpm_config_userconfig`, else `PNPM_CONFIG_USERCONFIG`, else
 * `npm_config_userconfig`, else `NPM_CONFIG_USERCONFIG`, else `~/.npmrc`. The
 * lower-case name beats the upper-case one whatever the environment's order
 * (rb7–rb10), a mixed-case name is not read (rc4), and the value is used raw:
 * neither `${VAR}` nor `~` is expanded (ra1–ra3). Relative means to cwd.
 */
const userFile = (cwd: string, { env, home }: NpmrcSources): string => {
  const configured =
    nonEmpty(env.pnpm_config_userconfig) ??
    nonEmpty(env.PNPM_CONFIG_USERCONFIG) ??
    nonEmpty(env.npm_config_userconfig) ??
    nonEmpty(env.NPM_CONFIG_USERCONFIG)
  return configured === undefined
    ? path.join(home, '.npmrc')
    : path.resolve(cwd, configured)
}

/**
 * pnpm 12's layers, highest first, each key taken from the first that sets
 * it. Verified on pnpm 12.15.0 and 12.14.0, 2026-10-26 (111 probe rows):
 * 1. `pnpm_config_*` / `PNPM_CONFIG_*` (see `PNPM_ENV`)
 * 2. `npm_config_*` credentials only (see `NPM_CREDENTIALS_ENV`)
 * 3. the project's `pnpm-workspace.yaml` routes; a `${…}` value falls through
 * 4. the global `config.yaml` routes (no credentials); `${…}` expands
 * 5. the project's `.npmrc`; an entry holding `${…}` is left out
 * 6. the global `auth.ini`; `${…}` expands
 * 7. the user file (`userconfig`, else `~/.npmrc`); `${…}` expands in its
 *    content. A relative `userconfig` is cwd-relative and is used raw (no
 *    `${…}`, no `~`), and a missing file leaves no user layer.
 *
 * An unset `${VAR}` in a token becomes `''`: pnpm sends `Bearer ` with nothing
 * after it. autd's lookup skips an empty credential and falls back to a
 * shorter same-host prefix's, as it does for an empty token anywhere; nothing
 * leaves the host. Otherwise no `Authorization` is sent.
 * The legacy `rc` and npm's `<prefix>/etc/npmrc` are not read. A member
 * reads the workspace root's project files.
 */
export const pnpmNpmrcLayers = (
  cwd: string,
  sources: NpmrcSources,
): NpmrcLayer[] => {
  const { env } = sources
  const root = pnpmProjectRoot(cwd)
  const configDir = pnpmConfigDir(cwd, sources)
  const yamlFile = path.join(root, 'pnpm-workspace.yaml')
  const globalYaml = path.join(configDir, 'config.yaml')
  return [
    envLayer(env, PNPM_ENV),
    envLayer(env, NPM_CREDENTIALS_ENV),
    routeLayer(yamlFile, pnpmRegistrySettings(readTextFile(yamlFile))),
    routeLayer(
      globalYaml,
      pnpmRegistrySettings(readTextFile(globalYaml), {
        env,
        file: 'config.yaml',
      }),
    ),
    npmrcFileLayer(path.join(root, '.npmrc'), env, {
      substitute: null,
      omitReferences: true,
    }),
    npmrcFileLayer(path.join(configDir, 'auth.ini'), env, {
      substitute: substitutePnpm,
    }),
    npmrcFileLayer(userFile(cwd, sources), env, {
      substitute: substitutePnpm,
    }),
  ]
}
