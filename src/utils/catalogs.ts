import fs from 'fs'
import path from 'path'
import { parsePnpmYaml, pnpmCatalogs } from '@/managers/pnpm/workspaceYaml'
import { isRecord } from './isRecord'
import { formatLike } from './manifests'
import { DEFAULT_SAVE_STYLE, type SaveStyle } from './saveStyle'
import { nextVersionSpec } from './versionSpecs'

/** A `name: value` line: indent, the name with its quotes, the separator, then the value text. */
const YAML_KEY = /^(\s+)(['"]?)([^'"\s#][^'"\s]*)\2(\s*:\s*)(.*)$/

/**
 * Splits the value text of an entry into its spec and what follows it. The
 * spec is the whole value: a quoted string in full (`"^18 || ^19"`), or an
 * unquoted value up to a trailing ` #` comment (`>=18.0.0 <19`). `rest` is
 * the comment (and the space before it) and is written back untouched.
 * Undefined for an entry without a value (the key of a named catalog).
 */
const splitYamlValue = (
  value: string,
): { quote: string; spec: string; rest: string } | undefined => {
  const quoted = /^(['"])(.*?)\1(\s*(?:#.*)?)$/.exec(value)
  if (quoted && quoted[2] !== '') {
    return { quote: quoted[1], spec: quoted[2], rest: quoted[3] }
  }
  const comment = value.search(/\s#/)
  const spec = (comment === -1 ? value : value.slice(0, comment)).trimEnd()
  if (spec === '' || spec.startsWith('#')) return undefined
  return { quote: '', spec, rest: value.slice(spec.length) }
}

/**
 * Walks the catalog entries of pnpm-workspace.yaml, the ones under `catalog:`
 * (the `default` catalog) and under each named catalog in `catalogs:`, and
 * returns the text with each entry `visit` answers for rewritten. `visit`
 * gets the catalog's name, the entry's name and its spec; a spec it returns
 * replaces the entry's, `undefined` leaves the line alone. Every other block
 * (`overrides`, `peerDependencyRules`, …) and every other line stays as it
 * was, and an entry keeps its quotes and trailing comment. Only the writer
 * uses it; reading goes through `parsePnpmYaml` (#229), and a test keeps
 * the two agreeing on what an entry is.
 */
const mapPnpmCatalogEntries = (
  text: string,
  visit: (catalog: string, name: string, spec: string) => string | undefined,
): string => {
  // The top-level key the current line sits under, and, inside `catalogs:`,
  // the indent and name of the named catalog it belongs to.
  let block: string | undefined
  let catalogIndent: number | undefined
  let catalogName: string | undefined

  const rewriteLine = (line: string): string => {
    if (/^\S/.test(line)) {
      if (!line.startsWith('#')) {
        block = /^(['"]?)([^'"\s:]+)\1\s*:/.exec(line)?.[2]
        catalogIndent = undefined
        catalogName = undefined
      }
      return line
    }
    if (block !== 'catalog' && block !== 'catalogs') return line
    if (/^\s*(#|$)/.test(line)) return line

    if (block === 'catalogs') {
      const catalogKey = /^(\s+)(['"]?)([^'"\s:]+)\2\s*:\s*(#.*)?$/.exec(line)
      if (catalogKey) {
        catalogIndent = catalogKey[1].length
        catalogName = catalogKey[3]
        return line
      }
    }

    const entry = YAML_KEY.exec(line)
    const value = entry ? splitYamlValue(entry[5]) : undefined
    if (!entry || !value) return line
    const [, indent, keyQuote, name, separator] = entry
    const { quote, spec, rest } = value
    if (
      block === 'catalogs' &&
      !(indent.length > (catalogIndent ?? Infinity))
    ) {
      return line
    }

    const newSpec = visit(
      block === 'catalog' ? 'default' : (catalogName as string),
      name,
      spec,
    )
    if (newSpec === undefined) return line
    return `${indent}${keyQuote}${name}${keyQuote}${separator}${quote}${newSpec}${quote}${rest}`
  }

  // A CRLF file keeps its `\r`: the line is rewritten without it and gets it back.
  return text
    .split('\n')
    .map((line) =>
      line.endsWith('\r')
        ? `${rewriteLine(line.slice(0, -1))}\r`
        : rewriteLine(line),
    )
    .join('\n')
}

/**
 * Rewrites catalog versions in pnpm-workspace.yaml: the entries under
 * `catalog:` and under each named catalog in `catalogs:`. With `catalog`
 * (`default` for `catalog:`) only that catalog's entries move, so a package
 * that two named catalogs pin differently changes in the one asked for;
 * without it, every catalog's entry of that name does.
 */
export const updatePNPMWorkspaceYAML = async (
  cwd: string,
  versions: Record<string, string>,
  style: SaveStyle = DEFAULT_SAVE_STYLE,
  catalog?: string,
): Promise<void> => {
  const pnpmWorkspaceYamlPath = path.join(cwd, 'pnpm-workspace.yaml')
  const updated = mapPnpmCatalogEntries(
    fs.readFileSync(pnpmWorkspaceYamlPath, 'utf8'),
    (entryCatalog, name, spec) =>
      (catalog === undefined || entryCatalog === catalog) &&
      Object.hasOwn(versions, name)
        ? nextVersionSpec(spec, versions[name], style)
        : undefined,
  )
  fs.writeFileSync(pnpmWorkspaceYamlPath, updated, 'utf8')
}

/**
 * The catalogs of pnpm-workspace.yaml by name (`default` for `catalog:` and
 * for `catalogs: default:`), read by the one pnpm yaml reader (#229).
 */
export const readPnpmCatalogs = (
  yaml: string,
): Record<string, Record<string, string>> => pnpmCatalogs(parsePnpmYaml(yaml))

/**
 * Where a bun package.json keeps its catalogs. Bun reads them from
 * `workspaces.catalog` / `workspaces.catalogs` as well as the top level, and
 * the `workspaces` one replaces the top-level one as a whole, the default
 * catalog and the named ones independently (verified on bun 1.4.4: with both
 * set, `workspaces.catalog` won and a package only in the top-level
 * `catalog` was "not in the catalog").
 */
const bunCatalogSources = (
  manifest: Record<string, unknown> | undefined,
): {
  defaultCatalog: Record<string, unknown> | undefined
  named: Record<string, unknown> | undefined
} => {
  const workspaces = isRecord(manifest?.workspaces)
    ? manifest.workspaces
    : undefined
  const pick = (field: 'catalog' | 'catalogs') => {
    const fromWorkspaces = workspaces?.[field]
    if (isRecord(fromWorkspaces)) return fromWorkspaces
    const topLevel = manifest?.[field]
    return isRecord(topLevel) ? topLevel : undefined
  }
  return { defaultCatalog: pick('catalog'), named: pick('catalogs') }
}

/**
 * The catalogs of a bun package.json by name (`default` for `catalog`), string
 * entries only, from the fields bun reads and `updateBunCatalogs` writes.
 */
export const readBunCatalogs = (
  manifest: Record<string, unknown> | undefined,
): Record<string, Record<string, string>> => {
  const strings = (entries: Record<string, unknown>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(entries).filter(
        (entry): entry is [string, string] => typeof entry[1] === 'string',
      ),
    )

  const { defaultCatalog, named } = bunCatalogSources(manifest)
  const catalogs: Record<string, Record<string, string>> = {}
  if (defaultCatalog) catalogs.default = strings(defaultCatalog)
  if (named) {
    for (const [name, entries] of Object.entries(named)) {
      if (isRecord(entries)) catalogs[name] = strings(entries)
    }
  }
  return catalogs
}

/**
 * Moves catalog entries in a bun package.json, in the fields bun reads them
 * from. With `catalog` (`default` for the singular `catalog`) only that
 * catalog's entries move; without it, every catalog's entry of that name.
 */
export const updateBunCatalogs = async (
  cwd: string,
  versions: Record<string, string>,
  style: SaveStyle = DEFAULT_SAVE_STYLE,
  catalog?: string,
): Promise<void> => {
  const packageJsonPath = path.join(cwd, 'package.json')
  const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8')
  const packageJson = JSON.parse(packageJsonContent)
  const { defaultCatalog, named } = bunCatalogSources(packageJson)

  let catalogsUpdated = false
  const move = (entries: Record<string, unknown>): void => {
    for (const packageName of Object.keys(versions)) {
      const current = entries[packageName]
      if (typeof current === 'string' && current !== '') {
        entries[packageName] = nextVersionSpec(
          current,
          versions[packageName],
          style,
        )
        catalogsUpdated = true
      }
    }
  }

  if (defaultCatalog && (catalog === undefined || catalog === 'default')) {
    move(defaultCatalog)
  }
  if (named) {
    for (const [name, entries] of Object.entries(named)) {
      if (isRecord(entries) && (catalog === undefined || catalog === name)) {
        move(entries)
      }
    }
  }

  // Only write if something was updated
  if (catalogsUpdated) {
    fs.writeFileSync(
      packageJsonPath,
      formatLike(packageJsonContent, packageJson),
      'utf8',
    )
  }
}
