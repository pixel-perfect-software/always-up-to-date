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
 * Whether a plain flow-map value is a string to `parsePnpmYaml`: not empty,
 * `~` or `null`, a block scalar header, or what the reader leaves out
 * (`[`, `{`, an anchor, an alias, a tag, a reserved indicator).
 */
const isPlainString = (text: string): boolean =>
  text !== '' &&
  text !== '~' &&
  text !== 'null' &&
  !/^[|>][1-9+-]*$/.test(text) &&
  !/^[[{&*!%@`]/.test(text)

/** One `key: value` item of a flow map: what precedes the value, the key's quote, the value, and the space after it. */
const FLOW_ITEM = /^(\s*(['"]?)[^'"\s][^'"\s]*?\2\s*:\s+)(.*?)(\s*)$/

/**
 * Rewrites the entries of a flat one-line flow map (`{ react: ^18, "ms":
 * '2.1.3' }`, after an optional anchor), the form `parsePnpmYaml` reads a
 * catalog in too (#246). `visit` gets each entry's name and spec as the
 * block walk passes them; every other byte (spacing, commas, quotes, a
 * trailing comment) stays. Undefined when `value` is not such a map, or
 * holds a nested one, which the reader leaves out as a whole: the line is
 * then left alone. An entry whose value the reader doesn't take as a
 * string (a flow sequence, `~`) is left alone too.
 */
const mapFlowMapEntries = (
  value: string,
  visit: (name: string, spec: string) => string | undefined,
): string | undefined => {
  const open = /^(&\S+\s+)?\{/.exec(value)?.[0].length
  if (open === undefined) return undefined

  // Where each item starts: after the `{` and after each comma at the
  // map's own level, outside quotes.
  const starts = [open]
  let close = -1
  let quote: string | undefined
  let depth = 0
  for (let i = open; i < value.length && close === -1; i++) {
    const c = value[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = undefined
    } else if (c === '"' || c === "'") quote = c
    else if (c === '{') return undefined
    else if (c === '[') depth++
    else if (c === ']') depth--
    else if (c === ',' && depth === 0) starts.push(i + 1)
    else if (c === '}' && depth === 0) close = i
  }
  if (close === -1 || !/^\s*(#.*)?$/.test(value.slice(close + 1))) {
    return undefined
  }

  const ends = [...starts.slice(1).map((start) => start - 1), close]
  const items = starts.map((start, i) => {
    const item = value.slice(start, ends[i])
    const entry = FLOW_ITEM.exec(item)
    if (!entry) return item
    const [, head, keyQuote, raw, after] = entry
    const quoted = /^(['"])(.+)\1$/.exec(raw)
    if (!quoted && !isPlainString(raw)) return item
    const key = head.trim().replace(/\s*:$/, '')
    const newSpec = visit(
      keyQuote ? key.slice(1, -1) : key,
      quoted ? quoted[2] : raw,
    )
    if (newSpec === undefined) return item
    const valueQuote = quoted ? quoted[1] : ''
    return `${head}${valueQuote}${newSpec}${valueQuote}${after}`
  })
  return `${value.slice(0, open)}${items.join(',')}${value.slice(close)}`
}

/**
 * Walks the catalog entries of pnpm-workspace.yaml, the ones under `catalog:`
 * (the `default` catalog) and under each named catalog in `catalogs:`, and
 * returns the text with each entry `visit` answers for rewritten. `visit`
 * gets the catalog's name, the entry's name and its spec; a spec it returns
 * replaces the entry's, `undefined` leaves the line alone. Every other block
 * (`overrides`, `peerDependencyRules`, …) and every other line stays as it
 * was, and an entry keeps its quotes and trailing comment. A catalog written
 * as a flat one-line flow map (`catalog: { ms: ^2.1.1 }`, `  tools: { … }`
 * under `catalogs:`) has its entries rewritten in place, and a byte order
 * mark is kept and stepped over, as the reader does (#230). Only the writer
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

  // A catalog line whose value is a flow map: `head` is what precedes it.
  const flowLine = (
    line: string,
    catalog: string,
    head: string,
    value: string,
  ): string => {
    const rewritten = mapFlowMapEntries(value, (name, spec) =>
      visit(catalog, name, spec),
    )
    return rewritten === undefined ? line : `${head}${rewritten}`
  }

  const rewriteLine = (line: string): string => {
    if (/^\S/.test(line)) {
      if (!line.startsWith('#')) {
        block = /^(['"]?)([^'"\s:]+)\1\s*:/.exec(line)?.[2]
        catalogIndent = undefined
        catalogName = undefined
        const flow = /^(['"]?)catalog\1\s*:\s+(\S.*)$/.exec(line)
        if (flow) {
          const head = line.slice(0, line.length - flow[2].length)
          return flowLine(line, 'default', head, flow[2])
        }
      }
      return line
    }
    if (block !== 'catalog' && block !== 'catalogs') return line
    if (/^\s*(#|$)/.test(line)) return line

    if (block === 'catalogs') {
      // A named catalog written as a flow map, at a catalog key's indent.
      const flow = /^(\s+)(['"]?)([^'"\s:]+)\2\s*:\s+([&{].*)$/.exec(line)
      if (flow && flow[1].length <= (catalogIndent ?? Infinity)) {
        catalogIndent = flow[1].length
        catalogName = flow[3]
        const head = line.slice(0, line.length - flow[4].length)
        return flowLine(line, flow[3], head, flow[4])
      }
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

  // A byte order mark stays where it was, and the first line is read after it.
  const bom = text.startsWith('﻿') ? '﻿' : ''

  // A CRLF file keeps its `\r`: the line is rewritten without it and gets it back.
  const walked = text
    .slice(bom.length)
    .split('\n')
    .map((line) =>
      line.endsWith('\r')
        ? `${rewriteLine(line.slice(0, -1))}\r`
        : rewriteLine(line),
    )
    .join('\n')
  return `${bom}${walked}`
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
