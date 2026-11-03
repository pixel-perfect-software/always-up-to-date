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

/** Splits a flow sequence's items at top-level commas. */
const flowItems = (inner: string): string[] => {
  const items: string[] = []
  let quote: string | undefined
  let start = 0
  for (let i = 0; i < inner.length; i++) {
    const c = inner[i]
    if (quote) {
      if (c === '\\' && quote === '"') i++
      else if (c === quote) quote = undefined
    } else if (c === '"' || c === "'") quote = c
    else if (c === ',') {
      items.push(inner.slice(start, i))
      start = i + 1
    }
  }
  items.push(inner.slice(start))
  return items.map((item) => item.trim()).filter((item) => item !== '')
}

/** A scalar or a flow sequence of scalars; undefined for what this reader doesn't take (flow maps, anchors, tags, block scalars). */
const scalar = (raw: string): YamlNode | undefined => {
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
    const items = flowItems(text.slice(1, -1)).map(scalar)
    return items.every((item) => typeof item === 'string')
      ? (items as string[])
      : undefined
  }
  if (/^[{&*!|>%@`]/.test(text)) return undefined
  return text
}

/** `key: rest` of a mapping line: a quoted or plain key, then `:` and a space or the end. */
const splitKey = (text: string): { key: string; rest: string } | undefined => {
  if (text.startsWith('"') || text.startsWith("'")) {
    const close = text.indexOf(text[0], 1)
    if (close === -1 || text[close + 1] !== ':') return undefined
    const key = scalar(text.slice(0, close + 1))
    const rest = text.slice(close + 2)
    if (typeof key !== 'string' || (rest !== '' && !rest.startsWith(' ')))
      return undefined
    return { key, rest: rest.trim() }
  }
  const match = /^([^\s:#][^:]*?)\s*:(?:\s+(.*))?$/.exec(text)
  return match ? { key: match[1], rest: (match[2] ?? '').trim() } : undefined
}

const isItem = (text: string): boolean => text === '-' || text.startsWith('- ')

/**
 * A YAML file's block mappings and sequences, with plain and quoted scalars
 * and flow sequences: what yarn berry's `.yarnrc.yml` and `yarn.lock` and
 * pnpm's settings files use. What it doesn't
 * take (a flow map, an anchor, a block scalar) leaves that key out, never
 * the file, since a setting autd doesn't read may use it. A tab in the
 * indentation, which YAML forbids and berry fails on, makes the file empty.
 */
export const parseYaml = (text: string): Record<string, YamlNode> => {
  const lines: YamlLine[] = []
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    if (/^ *\t/.test(raw)) return {}
    const content = withoutComment(raw)
    if (content.trim() === '' || content.trim() === '---') continue
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
    rest: string,
  ): [YamlNode | undefined, number] => {
    if (rest !== '') return [scalar(rest), skipDeeper(i + 1, indent)]
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
      const pair = splitKey(lines[i].text)
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
      if (splitKey(rest) && !/^["'[]/.test(rest)) {
        // `- key: value` opens a mapping at the column of `key`.
        const column = indent + lines[i].text.length - rest.length
        lines[i] = { indent: column, text: rest }
        const [value, after] = parseMap(i, column)
        items.push(value)
        i = after
        continue
      }
      const value = scalar(rest)
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
