import logger from '@/utils/logger'
import { isRegistryUrl } from '@/utils/npmrcLoader'
import { unquote, yamlValue } from '@/utils/saveStyle'

/** What pnpm-workspace.yaml routes: the default registry and per-scope registries. */
export interface PnpmRegistrySettings {
  registry?: string
  /** '@scope' → registry URL */
  scopes: Record<string, string>
}

const withoutComment = (value: string): string =>
  value.replace(/(^|\s)#.*$/, '').trim()

interface Entry {
  key: string
  /** What follows `key:` on the same line; '' for a nested mapping. */
  value: string
  /** The entry's nested lines. */
  body: string[]
}

/**
 * The key and value of one `key: value` mapping line. A key is quoted, or
 * ends at its last `:` when nothing follows it (a URL key), or at its first
 * `: ` otherwise (`default: https://…`).
 */
const keyValue = (text: string): [string, string] | undefined => {
  const quoted = /^(["'])(.*?)\1\s*:\s*(.*)$/.exec(text)
  if (quoted) return [quoted[2], quoted[3]]
  if (text.endsWith(':')) return [text.slice(0, -1).trim(), '']
  const bare = /^(.*?):\s+(.*)$/.exec(text)
  return bare ? [bare[1], bare[2]] : undefined
}

/**
 * The entries of the top-level `registries:` mapping, written as a block or
 * as one-line flow (`registries: { default: https://x/, "@a": https://a/ }`).
 * A flow mapping is read only in its flat legacy shape.
 */
const registryEntries = (yaml: string): Entry[] => {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((line) => /^registries:/.test(line))
  if (start === -1) return []

  const flow = /^registries:\s*\{(.*)\}\s*(#.*)?$/.exec(lines[start])
  if (flow) {
    if (/[{[]/.test(flow[1])) {
      logger.debug(
        'Ignoring registries in pnpm-workspace.yaml: nested flow mapping',
      )
      return []
    }
    return flow[1].split(',').flatMap((pair) => {
      const found = keyValue(withoutComment(pair))
      return found ? [{ key: found[0], value: found[1], body: [] }] : []
    })
  }
  if (!/^registries:\s*(#.*)?$/.test(lines[start])) return []

  const entries: Entry[] = []
  let indent: number | undefined
  for (const line of lines.slice(start + 1)) {
    if (/^\s*(#.*)?$/.test(line)) continue
    if (/^\S/.test(line)) break
    const depth = line.length - line.trimStart().length
    indent ??= depth
    if (depth > indent) {
      entries.at(-1)?.body.push(line)
      continue
    }
    const found = keyValue(withoutComment(line))
    if (found) entries.push({ key: found[0], value: found[1], body: [] })
  }
  return entries
}

/** A `scopes: [a, b]` flow list or `scopes:` block list in an entry. */
const scopesOf = (entry: Entry): string[] => {
  const flow = /^\{.*\bscopes\s*:\s*\[([^\]]*)\]/.exec(entry.value)
  if (flow) return flow[1].split(',').map(unquote).filter(Boolean)

  const scopes: string[] = []
  let inScopes = false
  for (const line of entry.body.map(withoutComment)) {
    const inline = /^scopes:\s*\[([^\]]*)\]$/.exec(line)
    if (inline) {
      scopes.push(...inline[1].split(',').map(unquote).filter(Boolean))
      continue
    }
    if (/^scopes:$/.test(line)) {
      inScopes = true
      continue
    }
    const item = inScopes ? /^-\s*(.+)$/.exec(line) : null
    if (item) scopes.push(unquote(item[1]))
    else if (!/^-/.test(line)) inScopes = false
  }
  return scopes
}

const ecosystemOf = (entry: Entry): string | undefined => {
  const inline = /\becosystem\s*:\s*([^,}\s]+)/.exec(entry.value)
  if (inline) return unquote(inline[1])
  for (const line of entry.body.map(withoutComment)) {
    const found = /^ecosystem:\s*(.+)$/.exec(line)
    if (found) return unquote(found[1])
  }
  return undefined
}

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
 * A URL pnpm would use. Without `env` a value holding `${…}` is ignored (a
 * project file's); with it the reference is expanded first (a global file's).
 */
const usable = (
  raw: string,
  where: string,
  file: string,
  env?: NodeJS.ProcessEnv,
): string | undefined => {
  const url = env ? substitutePnpm(raw, env) : raw
  if (url === '') return undefined
  if (url.includes('${')) {
    logger.debug(`Ignoring ${where} in ${file}: holds \${…}`)
    return undefined
  }
  if (!isRegistryUrl(url)) {
    logger.debug(`Ignoring ${where} in ${file}: not an http(s) URL`)
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
  yaml: string,
  {
    env,
    file = 'pnpm-workspace.yaml',
  }: { env?: NodeJS.ProcessEnv; file?: string } = {},
): PnpmRegistrySettings => {
  const scopes: Record<string, string> = {}
  let fromRegistries: string | undefined

  for (const entry of registryEntries(yaml)) {
    const scalar = entry.value !== '' && !entry.value.startsWith('{')
    if (scalar) {
      const url = usable(
        unquote(entry.value),
        `registries.${entry.key}`,
        file,
        env,
      )
      if (!url) continue
      if (entry.key === 'default') fromRegistries = url
      else if (/^@.+/.test(entry.key)) scopes[entry.key] = url
      continue
    }

    const ecosystem = ecosystemOf(entry)
    if (ecosystem !== undefined && ecosystem !== 'npm') continue
    const url = usable(entry.key, `registries entry ${entry.key}`, file, env)
    if (!url) continue
    for (const scope of scopesOf(entry)) {
      if (scope === '@') fromRegistries = url
      else if (/^@.+/.test(scope)) scopes[scope] = url
    }
  }

  const topLevel = yamlValue(yaml, 'registry')
  return {
    registry: usable(topLevel ?? '', 'registry', file, env) ?? fromRegistries,
    scopes,
  }
}
