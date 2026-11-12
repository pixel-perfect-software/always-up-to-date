/**
 * A YAML subset reader for the managers' own settings and lock files (#107,
 * #168). No YAML dependency: the managers' files use a small part of YAML.
 */

/** A parsed YAML node. Scalars stay strings: berry coerces each by its setting's type. */
export type YamlNode = string | null | YamlNode[] | { [key: string]: YamlNode }

interface YamlLine {
  indent: number
  text: string
}

/** Cuts a `#` comment that starts a line or follows a space, outside quotes. */
const withoutComment = (line: string): string => {
  let quote: string | undefined
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = undefined
    } else if (c === '"' || c === "'") quote = c
    else if (c === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i)
    }
  }
  return line
}

const ESCAPES: Record<string, string> = {
  '0': '\0',
  n: '\n',
  t: '\t',
  r: '\r',
  '"': '"',
  '\\': '\\',
  '/': '/',
  ' ': ' ',
}

/** A double-quoted scalar's text, or undefined when it doesn't close or uses an escape outside YAML's. */
const doubleQuoted = (raw: string): string | undefined => {
  let out = ''
  for (let i = 1; i < raw.length; i++) {
    const c = raw[i]
    if (c === '"') return i === raw.length - 1 ? out : undefined
    if (c !== '\\') {
      out += c
      continue
    }
    const next = raw[++i]
    if (next in ESCAPES) out += ESCAPES[next]
    else if (next === 'x' || next === 'u' || next === 'U') {
      const size = next === 'x' ? 2 : next === 'u' ? 4 : 8
      const hex = raw.slice(i + 1, i + 1 + size)
      if (!/^[0-9a-fA-F]+$/.test(hex) || hex.length !== size) return undefined
      out += String.fromCodePoint(Number.parseInt(hex, 16))
      i += size
    } else return undefined
  }
  return undefined
}

/** Splits a flow collection's items at its own commas, outside quotes and nested brackets. */
const flowItems = (inner: string): string[] => {
  const items: string[] = []
  let quote: string | undefined
  let depth = 0
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = undefined
    } else if (c === '"' || c === "'") quote = c
    else if (c === '[' || c === '{') depth++
    else if (c === ']' || c === '}') depth--
    else if (c === ',' && depth === 0) {
      items.push(inner.slice(start, i))
      start = i + 1
    }
  }
  items.push(inner.slice(start))
  return items.map((item) => item.trim()).filter((item) => item !== '')
}

/** What a caller lets the reader take beyond its subset. */
export interface YamlOptions {
  /**
   * Read a one-line flow map whose values are scalars or flow sequences of
   * scalars (`{ default: https://r/, "@a": https://a/ }`); one that holds a
   * nested map is still left out. Off for berry's files, whose reading
   * leaves every flow map out.
   */
  flowMaps?: boolean
  /**
   * Read a mapping value that carries an anchor (`catalog: &c` over a
   * block, `savePrefix: &p "~"`) as the node without it; an alias (`*c`)
   * is still left out. Off for berry's files, whose reading leaves an
   * anchored key out.
   */
  anchors?: boolean
}

/**
 * Where a plain mapping key ends: at the first `:` followed by a space or
 * the end of the text, so a URL key (`http://h:4873/:`) keeps its colons.
 */
const keyEnd = (text: string): number => {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === ':' && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      return i
    }
  }
  return -1
}

/** A flat flow map's items; undefined when an item is not `key: value` or holds a nested map. */
const flowMap = (
  inner: string,
  options: YamlOptions,
): Record<string, YamlNode> | undefined => {
  const map: Record<string, YamlNode> = Object.create(null)
  for (const item of flowItems(inner)) {
    const pair = splitKey(item, options)
    if (!pair || pair.rest.startsWith('{')) return undefined
    const value = scalar(pair.rest, options)
    if (value === undefined) return undefined
    map[pair.key] = value
  }
  return map
}

/**
 * A scalar or a flow sequence of scalars, and with `flowMaps` a flat flow
 * map; undefined for what this reader doesn't take (other flow maps,
 * anchors, tags, block scalars).
 */
const scalar = (
  raw: string,
  options: YamlOptions = {},
): YamlNode | undefined => {
  const text = raw.trim()
  if (text === '' || text === '~' || text === 'null') return null
  if (text.startsWith('"')) return doubleQuoted(text)
  if (text.startsWith("'")) {
    return text.length > 1 && text.endsWith("'")
      ? text.slice(1, -1).replace(/''/g, "'")
      : undefined
  }
  if (text.startsWith('[')) {
    if (!text.endsWith(']')) return undefined
    const items = flowItems(text.slice(1, -1)).map((item) => scalar(item))
    return items.every((item) => typeof item === 'string')
      ? (items as string[])
      : undefined
  }
  if (text.startsWith('{') && options.flowMaps) {
    return text.endsWith('}') ? flowMap(text.slice(1, -1), options) : undefined
  }
  // `|` or `>` opens a block scalar only with a header after it (`|`, `>-`,
  // `|2+`); `>=18.0.0 <19`, a range catalogs and overrides hold, is text.
  if (/^[|>][1-9+-]*$/.test(text)) return undefined
  if (/^[{&*!%@`]/.test(text)) return undefined
  return text
}

/**
 * `key: rest` of a mapping line: a quoted key, or a plain one up to the
 * first `:` followed by a space or the end, then the rest.
 */
const splitKey = (
  text: string,
  options: YamlOptions = {},
): { key: string; rest: string } | undefined => {
  if (text.startsWith('"') || text.startsWith("'")) {
    const close = text.indexOf(text[0], 1)
    if (close === -1) return undefined
    const after = text.slice(close + 1).trimStart()
    if (!after.startsWith(':')) return undefined
    const key = scalar(text.slice(0, close + 1), options)
    const rest = after.slice(1)
    if (typeof key !== 'string' || (rest !== '' && !/^\s/.test(rest)))
      return undefined
    return { key, rest: rest.trim() }
  }
  if (/^[\s:#]/.test(text)) return undefined
  const end = keyEnd(text)
  if (end === -1) return undefined
  return {
    key: text.slice(0, end).trimEnd(),
    rest: text.slice(end + 1).trim(),
  }
}

const isItem = (text: string): boolean => text === '-' || text.startsWith('- ')

/**
 * A YAML file's block mappings and sequences, with plain and quoted scalars
 * and flow sequences: what yarn berry's `.yarnrc.yml` and `yarn.lock` and
 * pnpm's settings files use. What it doesn't
 * take (a flow map or an anchor unless an option allows it, a block scalar)
 * leaves that key out, never the file, since a setting autd doesn't read
 * may use it. A tab in the indentation of a line with content, which YAML
 * forbids and berry and pnpm fail on, makes the file empty; a blank or
 * comment line may hold one, as YAML allows.
 */
export const parseYaml = (
  text: string,
  options: YamlOptions = {},
): Record<string, YamlNode> => {
  const lines: YamlLine[] = []
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const content = withoutComment(raw)
    if (content.trim() === '' || content.trim() === '---') continue
    if (/^ *\t/.test(raw)) return {}
    const indent = /^ */.exec(content)?.[0].length ?? 0
    lines.push({ indent, text: content.trim() })
  }

  // Skips every line indented deeper than `indent` from `i`.
  const skipDeeper = (i: number, indent: number): number => {
    while (i < lines.length && lines[i].indent > indent) i++
    return i
  }

  const parseBlock = (i: number, indent: number): [YamlNode, number] =>
    isItem(lines[i].text) ? parseSequence(i, indent) : parseMap(i, indent)

  const valueAfter = (
    i: number,
    indent: number,
    text: string,
  ): [YamlNode | undefined, number] => {
    const rest = options.anchors ? text.replace(/^&\S+\s*/, '') : text
    if (rest !== '') return [scalar(rest, options), skipDeeper(i + 1, indent)]
    const next = lines[i + 1]
    if (next && next.indent > indent) return parseBlock(i + 1, next.indent)
    // YAML lets a key's sequence sit at the key's own indent.
    if (next && next.indent === indent && isItem(next.text)) {
      return parseSequence(i + 1, indent)
    }
    return [null, i + 1]
  }

  const parseMap = (start: number, indent: number): [YamlNode, number] => {
    const map: Record<string, YamlNode> = Object.create(null)
    let i = start
    while (i < lines.length && lines[i].indent === indent) {
      if (isItem(lines[i].text)) break
      const pair = splitKey(lines[i].text, options)
      if (!pair) {
        i = skipDeeper(i + 1, indent)
        continue
      }
      const [value, next] = valueAfter(i, indent, pair.rest)
      if (value !== undefined) map[pair.key] = value
      i = next
    }
    return [map, skipDeeper(i, indent)]
  }

  const parseSequence = (start: number, indent: number): [YamlNode, number] => {
    const items: YamlNode[] = []
    let i = start
    while (
      i < lines.length &&
      lines[i].indent === indent &&
      isItem(lines[i].text)
    ) {
      const rest = lines[i].text.slice(1).trimStart()
      if (rest === '') {
        const next = lines[i + 1]
        if (next && next.indent > indent) {
          const [value, after] = parseBlock(i + 1, next.indent)
          items.push(value)
          i = after
        } else {
          items.push(null)
          i++
        }
        continue
      }
      if (splitKey(rest, options) && !/^["'[{]/.test(rest)) {
        // `- key: value` opens a mapping at the column of `key`.
        const column = indent + lines[i].text.length - rest.length
        lines[i] = { indent: column, text: rest }
        const [value, after] = parseMap(i, column)
        items.push(value)
        i = after
        continue
      }
      const value = scalar(rest, options)
      if (value !== undefined) items.push(value)
      i = skipDeeper(i + 1, indent)
    }
    return [items, i]
  }

  if (lines.length === 0) return {}
  const [root] = parseBlock(0, lines[0].indent)
  return root !== null && !Array.isArray(root) && typeof root === 'object'
    ? root
    : {}
}
