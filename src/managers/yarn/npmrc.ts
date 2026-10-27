import path from 'path'

import { ancestorFiles } from '@/managers/yarn/yarnrc'
import {
  type EnvRule,
  envLayer,
  execPrefix,
  type NpmrcLayer,
  type NpmrcSources,
  nonEmpty,
  npmrcFileLayer,
} from '@/utils/npmrcLoader'

/**
 * `npm_config_*` as yarn v1 reads it: any case of the prefix, then the name
 * lower-cased with `__` as `.` and a single `_` as `-`. A key holding `.` is
 * skipped (yarn nests it as an object path). A `//host/:_authToken` key is
 * mangled by the same rule (`:-authtoken`, or nested when the host has a dot),
 * so no credential is ever read from the environment, and `NPM_CONFIG_@ACME:REGISTRY`
 * becomes `@acme:registry`. Values are used as written: no `${VAR}` expansion.
 * Verified on yarn 1.22.22, 2026-10-26 (y28d, y29, y30, y31b).
 */
export const YARN_NPM_ENV: EnvRule = {
  prefix: /^npm_config_/i,
  key: (rest) => {
    const key = rest
      .toLowerCase()
      .replace(/__/g, '.')
      .replace(/([^_])_/g, '$1-')
    return key.includes('.') ? undefined : key
  },
  substitute: null,
}

/**
 * yarn v1's `.npmrc` layers, highest first, each key from the first that sets
 * it. Verified on yarn 1.22.22, 2026-10-26 (y20-y32), credentials included:
 * 1. `npm_config_*` (see `YARN_NPM_ENV`)
 * 2. the `.npmrc` in cwd (a workspace member when run from one)
 * 3. the user file: `npm_config_userconfig` resolved against cwd (no `~`
 *    expansion; a missing file means no user file), else `~/.npmrc`
 * 4. `${PREFIX or the running node's prefix}/etc/npmrc`
 * 5. each parent directory's `.npmrc`, nearest first, not the filesystem root
 *
 * `${VAR}` expands in file values. Yarn fails the run when a variable is
 * unset; autd keeps the literal, and drops a credential still holding `${…}`.
 * Homebrew's yarn wrapper forces `PREFIX=/opt/homebrew`, so for its users the
 * prefix file is that one unless autd runs with the same `PREFIX`.
 */
export const yarnNpmrcLayers = (
  cwd: string,
  sources: NpmrcSources,
): NpmrcLayer[] => {
  const { env, home } = sources
  const envL = envLayer(env, YARN_NPM_ENV)
  const userconfig = envL.values.userconfig
  const userFile =
    typeof userconfig === 'string' && userconfig !== ''
      ? path.resolve(cwd, userconfig)
      : path.join(home, '.npmrc')
  const prefixFile = path.join(
    nonEmpty(env.PREFIX) ?? execPrefix(sources),
    'etc',
    'npmrc',
  )
  const [project, ...parents] = ancestorFiles(cwd, '.npmrc')
  return [
    envL,
    npmrcFileLayer(project, env),
    npmrcFileLayer(userFile, env),
    npmrcFileLayer(prefixFile, env),
    ...parents.slice(0, -1).map((file) => npmrcFileLayer(file, env)),
  ]
}
