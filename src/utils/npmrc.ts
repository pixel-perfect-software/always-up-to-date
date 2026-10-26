export type NpmrcScalar = string | boolean | null
export type NpmrcValue = NpmrcScalar | NpmrcScalar[]
/** A parsed .npmrc: flat keys, built without a prototype. */
export type Npmrc = Record<string, NpmrcValue>

const ENV_REFERENCE = /(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g

/**
 * Replaces `${VAR}` references the way npm's config does. An unset `${VAR}`
 * stays literal, `${VAR?}` becomes an empty string, and an odd run of
 * backslashes escapes the reference (half of them are consumed).
 */
export const substituteEnv = (text: string, env: NodeJS.ProcessEnv): string =>
  text.replace(
    ENV_REFERENCE,
    (original, escapes: string, name: string, modifier) => {
      const fallback = modifier === '?' ? '' : `\${${name}}`
      const value = env[name] !== undefined ? env[name] : fallback
      if (escapes.length % 2) return original.slice((escapes.length + 1) / 2)
      return escapes.slice(escapes.length / 2) + value
    },
  )

const isQuoted = (value: string): boolean =>
  (value.startsWith('"') && value.endsWith('"')) ||
  (value.startsWith("'") && value.endsWith("'"))

/**
 * A key or value as written. Double quotes are JSON-decoded (kept as written
 * when that fails), single quotes are stripped, and an unquoted text ends at
 * the first unescaped `;` or `#`, with `\;`, `\#` and `\\` unescaped.
 */
const unquote = (raw: string): string => {
  const value = raw.trim()
  if (isQuoted(value)) {
    if (value.startsWith("'")) return value.slice(1, -1)
    try {
      const parsed: unknown = JSON.parse(value)
      return typeof parsed === 'string' ? parsed : value
    } catch {
      return value
    }
  }

  let escaped = false
  let result = ''
  for (const char of value) {
    if (escaped) {
      result += '\\;#'.includes(char) ? char : `\\${char}`
      escaped = false
    } else if (char === ';' || char === '#') {
      break
    } else if (char === '\\') {
      escaped = true
    } else {
      result += char
    }
  }
  if (escaped) result += '\\'
  return result.trim()
}

const LINE = /^\[([^\]]*)\]\s*$|^([^=]+)(=(.*))?$/

/**
 * Parses .npmrc text: ini's syntax for top-level keys, then npm's `${VAR}`
 * substitution on keys and values. Parsing stops at the first `[section]`,
 * since .npmrc has none. A later plain key replaces an earlier one; `key[]`
 * collects an array, and a plain key repeated after one appends to it.
 */
export const parseNpmrc = (text: string, env: NodeJS.ProcessEnv): Npmrc => {
  const result: Npmrc = Object.create(null)

  for (const line of text.split(/[\r\n]+/)) {
    if (!line || /^\s*[;#]/.test(line) || /^\s*$/.test(line)) continue
    const match = LINE.exec(line)
    if (!match) continue
    if (match[1] !== undefined) break

    const keyText = unquote(match[2])
    const isArray = keyText.length > 2 && keyText.endsWith('[]')
    const key = substituteEnv(isArray ? keyText.slice(0, -2) : keyText, env)
    if (key === '__proto__') continue

    let value: NpmrcScalar
    if (match[3] === undefined) {
      value = true
    } else {
      const raw = unquote(match[4])
      if (raw === 'true') value = true
      else if (raw === 'false') value = false
      else if (raw === 'null') value = null
      else value = substituteEnv(raw, env)
    }

    const existing = result[key]
    if (isArray) {
      if (existing === undefined) result[key] = []
      else if (!Array.isArray(existing)) result[key] = [existing]
    }
    const current = result[key]
    if (Array.isArray(current)) current.push(value)
    else result[key] = value
  }

  return result
}
