import path from 'path'

import { ancestorFiles } from '@/utils/ancestors'
import type { Npmrc, Substitute } from '@/utils/npmrc'
import {
  type EnvRule,
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
 * yarn's environment layer. Unlike `envLayer`, an empty value is kept: yarn's
 * `mergeEnv` sets it, and it hides the same key in every `.npmrc` (an empty
 * `NPM_CONFIG_REGISTRY` sends the default registry to `.yarnrc` or yarn's own,
 * an empty `npm_config_@acme:registry` unroutes the scope). `true` and
 * `false` become booleans. Verified on yarn 1.22.22, 2026-10-27 (a1, a1c, a2,
 * a2c). Of several variables naming one key, the later in the environment wins.
 */
const yarnEnvLayer = (env: NodeJS.ProcessEnv): NpmrcLayer => {
  const values: Npmrc = Object.create(null)
  const labels: Record<string, string> = Object.create(null)
  for (const [name, raw] of Object.entries(env)) {
    if (raw === undefined) continue
    const match = YARN_NPM_ENV.prefix.exec(name)
    if (!match) continue
    const key = YARN_NPM_ENV.key(name.slice(match[0].length), name)
    if (key === undefined) continue
    values[key] = raw === 'true' ? true : raw === 'false' ? false : raw
    labels[key] = name
  }
  return { kind: 'env', values, labels }
}

const YARN_REFERENCE = /(\\*)\$\{([^}]+)\}/g

/**
 * yarn's `envReplace` for one value: `${NAME}` is the variable `NAME`, the
 * name being everything up to `}` (so `${TOKEN?}` names a variable `TOKEN?`).
 * A reference behind an odd run of backslashes is kept as written, backslashes
 * included; behind an even run the backslashes are dropped. yarn throws when
 * the variable is unset; here the reference stays, and a credential still
 * holding `${…}` is dropped, as for any reference that cannot be resolved.
 * Verified on yarn 1.22.22, 2026-10-27 (c1-c4, y31, y32).
 */
export const substituteYarn: Substitute = (text, env) =>
  text.replace(YARN_REFERENCE, (match, escapes: string, name: string) => {
    if (escapes.length % 2) return match
    const value = env[name]
    return value === undefined ? match : value
  })

/**
 * A `.npmrc` as yarn reads it: keys as written (yarn does not expand
 * variables in keys; `//${HOST}/:_authToken` never matches a host, b1), values
 * through `substituteYarn`.
 */
const yarnFileLayer = (file: string, env: NodeJS.ProcessEnv): NpmrcLayer => {
  const layer = npmrcFileLayer(file, env, { substitute: null })
  for (const [key, value] of Object.entries(layer.values)) {
    layer.values[key] = Array.isArray(value)
      ? value.map((v) => (typeof v === 'string' ? substituteYarn(v, env) : v))
      : typeof value === 'string'
        ? substituteYarn(value, env)
        : value
  }
  return layer
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
 * `${VAR}` expands in file values only (`substituteYarn`). Yarn fails the run
 * when a variable is unset; autd keeps the literal, and drops a credential
 * still holding `${…}`.
 * Not read: for the root user on Linux, yarn reads `/usr/local/share/.npmrc`
 * in place of `~/.npmrc` and then `~/.npmrc` after the prefix file (verified
 * in Docker, node:24, yarn 1.22.22, 2026-10-27); `DESTDIR`, which yarn joins
 * to the prefix on Unix. A different Node between yarn and autd gives a
 * different default prefix. Homebrew's yarn wrapper forces
 * `PREFIX=/opt/homebrew`, so for its users the prefix file is that one unless
 * autd runs with the same `PREFIX`.
 */
export const yarnNpmrcLayers = (
  cwd: string,
  sources: NpmrcSources,
): NpmrcLayer[] => {
  const { env, home } = sources
  const envL = yarnEnvLayer(env)
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
    yarnFileLayer(project, env),
    yarnFileLayer(userFile, env),
    yarnFileLayer(prefixFile, env),
    ...parents.slice(0, -1).map((file) => yarnFileLayer(file, env)),
  ]
}
