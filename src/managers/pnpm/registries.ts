import {
  type PnpmYaml,
  parsePnpmYaml,
  pnpmSetting,
} from '@/managers/pnpm/workspaceYaml'
import logger from '@/utils/logger'
import type { YamlNode } from '@/utils/yaml'

/** What pnpm-workspace.yaml routes: the default registry and per-scope registries. */
export interface PnpmRegistrySettings {
  registry?: string
  /** '@scope' → registry URL */
  scopes: Record<string, string>
  /**
   * How the file spells the setting behind a layer key (`registry`,
   * `@acme:registry`), for an error: `registries."@acme"`. A URL-keyed entry
   * is named by its scope, never by its URL, which may carry a token.
   */
  labels: Record<string, string>
}

/**
 * The `scopes` of a URL-keyed entry, as a flow or block list; a value that
 * is not a list holds none.
 */
const scopesOf = (entry: Record<string, YamlNode>): string[] =>
  Array.isArray(entry.scopes)
    ? entry.scopes.filter(
        (scope): scope is string => typeof scope === 'string' && scope !== '',
      )
    : []

/**
 * pnpm's `${VAR}` and `${VAR:-default}` in the user and global files and in
 * env values. An unset `${VAR}` with no default becomes `''` (pnpm warns
 * "Failed to replace env in config" and carries on), so a path or URL holding
 * it keeps its other parts and shadows lower layers. `${VAR:-default}` takes
 * the default when VAR is unset or empty, as a shell does. Verified on pnpm
 * 12.15.0 and 12.14.0, 2026-10-26 (p26, p34, p35, p34e-g).
 */
export const substitutePnpm = (text: string, env: NodeJS.ProcessEnv): string =>
  text.replace(
    /\$\{([^${}:]+)(?::-([^}]*))?\}/g,
    (_, name: string, fallback: string | undefined) =>
      fallback === undefined ? (env[name] ?? '') : env[name] || fallback,
  )

/**
 * The value pnpm would take for a route. Without `env` a value holding `${…}`
 * is ignored (a project file's, p33), so the next source decides. A value
 * that is no usable URL is kept, not dropped: pnpm fails the install on it
 * (ERR_PNPM_RESOLVING_NPM_RESOLVER_NETWORK_ERROR, verified on 12.15.0,
 * 2026-10-27), and so does an unset `${VAR}` that expanded to nothing in a
 * global file. `registryConfigFrom` records it as unusable.
 */
const usable = (
  raw: string,
  where: string,
  file: string,
  env?: NodeJS.ProcessEnv,
): string | undefined => {
  const url = env ? substitutePnpm(raw, env) : raw
  if (url.includes('${')) {
    logger.debug(`Ignoring ${where} in ${file}: holds \${…}`)
    return undefined
  }
  return url
}

/**
 * The registry routes in pnpm-workspace.yaml. Verified on pnpm 12.15.0 and
 * 12.14.0, 2026-10-26:
 * - top-level `registry:` beats a `registries` default;
 * - `registries` is either a map of `default` / `"@scope"` to a URL (a `"@"`
 *   key there is ignored) or URL-keyed entries with `scopes`, where `"@"`
 *   means the default registry (pnpm rejects a file that mixes the shapes;
 *   each entry is read on its own terms here);
 * - an entry with an `ecosystem` other than npm is not an npm route;
 * - the project file's value holding `${…}` is ignored, so the next source
 *   decides (p33); the global `config.yaml` is read with `env`, which expands
 *   it (p34c, p35d).
 * The file never carries credentials (p43).
 */
export const pnpmRegistrySettings = (
  yaml: string | PnpmYaml,
  {
    env,
    file = 'pnpm-workspace.yaml',
  }: { env?: NodeJS.ProcessEnv; file?: string } = {},
): PnpmRegistrySettings => {
  const doc = typeof yaml === 'string' ? parsePnpmYaml(yaml) : yaml
  const scopes: Record<string, string> = {}
  const labels: Record<string, string> = {}
  let fromRegistries: string | undefined
  let defaultLabel = 'registry'

  // A block or a flat one-line flow map (`parsePnpmYaml`); a flow map that
  // nests another is left out by the reader, so it routes nothing.
  const registries = doc.registries
  const entries =
    registries !== null &&
    typeof registries === 'object' &&
    !Array.isArray(registries)
      ? Object.entries(registries)
      : []

  for (const [key, value] of entries) {
    if (typeof value === 'string') {
      const url = usable(value, `registries.${key}`, file, env)
      if (url === undefined) continue
      if (key === 'default') {
        fromRegistries = url
        defaultLabel = 'registries.default'
      } else if (/^@.+/.test(key)) {
        scopes[key] = url
        labels[`${key}:registry`] = `registries."${key}"`
      }
      continue
    }

    const entry =
      value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value
        : {}
    const ecosystem = entry.ecosystem
    if (typeof ecosystem === 'string' && ecosystem !== 'npm') continue
    const url = usable(key, `registries entry ${key}`, file, env)
    if (url === undefined) continue
    for (const scope of scopesOf(entry)) {
      if (scope === '@') {
        fromRegistries = url
        defaultLabel = 'registries (a URL-keyed entry for the default)'
      } else if (/^@.+/.test(scope)) {
        scopes[scope] = url
        labels[`${scope}:registry`] =
          `registries (a URL-keyed entry for "${scope}")`
      }
    }
  }

  const topLevel = pnpmSetting(doc, 'registry')
  const fromTop =
    topLevel === undefined ? undefined : usable(topLevel, 'registry', file, env)
  labels.registry = fromTop === undefined ? defaultLabel : 'registry'
  return { registry: fromTop ?? fromRegistries, scopes, labels }
}
