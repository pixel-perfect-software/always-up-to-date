import type { RegistryConfig } from '@/types'
import logger from '@/utils/logger'
import { isRegistryUrl } from '@/utils/npmrcLoader'
import { yamlValue } from '@/utils/saveStyle'

/** What pnpm-workspace.yaml routes: the default registry and per-scope registries. */
export interface PnpmRegistrySettings {
  registry?: string
  /** '@scope' → registry URL */
  scopes: Record<string, string>
}

const unquote = (value: string): string =>
  value.trim().replace(/^(['"])(.*)\1$/, '$2')

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
 * The entries of the top-level `registries:` mapping. A key is quoted, or
 * ends at its last `:` when nothing follows it (a URL key), or at its first
 * `: ` otherwise (`default: https://…`).
 */
const registryEntries = (yaml: string): Entry[] => {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((line) => /^registries:\s*(#.*)?$/.test(line))
  if (start === -1) return []

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
    const text = withoutComment(line)
    const quoted = /^(["'])(.*?)\1\s*:\s*(.*)$/.exec(text)
    const bare = text.endsWith(':')
      ? [text, text.slice(0, -1).trim(), '']
      : /^(.*?):\s+(.*)$/.exec(text)
    const [key, value] = quoted
      ? [quoted[2], quoted[3]]
      : bare
        ? [bare[1], bare[2] ?? '']
        : [undefined, '']
    if (key !== undefined) entries.push({ key, value, body: [] })
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

/** A URL pnpm would use: no `${…}` (pnpm ignores those values) and http(s). */
const usable = (url: string, where: string): string | undefined => {
  if (url === '') return undefined
  if (url.includes('${')) {
    logger.debug(`Ignoring ${where} in pnpm-workspace.yaml: holds \${…}`)
    return undefined
  }
  if (!isRegistryUrl(url)) {
    logger.debug(`Ignoring ${where} in pnpm-workspace.yaml: not an http(s) URL`)
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
 * - a value holding `${…}` is ignored, so the next source decides.
 * The file never carries credentials.
 */
export const pnpmRegistrySettings = (yaml: string): PnpmRegistrySettings => {
  const scopes: Record<string, string> = {}
  let fromRegistries: string | undefined

  for (const entry of registryEntries(yaml)) {
    const scalar = entry.value !== '' && !entry.value.startsWith('{')
    if (scalar) {
      const url = usable(unquote(entry.value), `registries.${entry.key}`)
      if (!url) continue
      if (entry.key === 'default') fromRegistries = url
      else if (/^@.+/.test(entry.key)) scopes[entry.key] = url
      continue
    }

    const ecosystem = ecosystemOf(entry)
    if (ecosystem !== undefined && ecosystem !== 'npm') continue
    const url = usable(entry.key, `registries entry ${entry.key}`)
    if (!url) continue
    for (const scope of scopesOf(entry)) {
      if (scope === '@') fromRegistries = url
      else if (/^@.+/.test(scope)) scopes[scope] = url
    }
  }

  const topLevel = yamlValue(yaml, 'registry')
  return {
    registry: usable(topLevel ?? '', 'registry') ?? fromRegistries,
    scopes,
  }
}

/**
 * pnpm 12 reads registries from the project's pnpm-workspace.yaml over its
 * .npmrc, per key (verified on pnpm 12.15.0 and 12.14.0, 2026-10-26).
 * Credentials stay with the .npmrc entry for the host the request lands on.
 * Not read yet: `pnpm_config_*` variables, the global `config.yaml` and
 * `auth.ini`.
 */
export const applyPnpmRegistrySettings = (
  base: RegistryConfig,
  yaml: string,
): RegistryConfig => {
  const settings = pnpmRegistrySettings(yaml)
  return {
    ...base,
    registry: settings.registry ?? base.registry,
    scopedRegistries: { ...base.scopedRegistries, ...settings.scopes },
  }
}
