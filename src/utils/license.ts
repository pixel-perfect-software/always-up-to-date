import { isRecord } from './isRecord'

const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/** A legacy license entry, `{ type, url }`: its type. */
const licenseType = (value: unknown): string | undefined =>
  isRecord(value) ? trimmed(value.type) : undefined

/**
 * The license a manifest declares (#197), as published and trimmed: `license`
 * as a string, else the legacy `license: { type }`, else the legacy
 * `licenses` array (one type as is, several as an SPDX `OR`, each once).
 * Undefined when it declares none or the field is unreadable. Never parsed
 * as SPDX.
 */
export const licenseField = (
  manifest: Record<string, unknown>,
): string | undefined => {
  const own = trimmed(manifest.license) ?? licenseType(manifest.license)
  if (own) return own
  if (!Array.isArray(manifest.licenses)) return undefined
  const types = [
    ...new Set(
      (manifest.licenses as unknown[])
        .map(licenseType)
        .filter((type) => type !== undefined),
    ),
  ]
  if (types.length <= 1) return types[0]
  return `(${types.join(' OR ')})`
}

/** Whether the first `(` closes at the very end: the parentheses wrap the whole text. */
const wrapped = (text: string): boolean => {
  if (!text.startsWith('(') || !text.endsWith(')')) return false
  let depth = 0
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '(') depth++
    else if (text[i] === ')') depth--
    if (depth === 0) return i === text.length - 1
  }
  return false
}

// SPDX deprecated the bare GNU ids for `-only` and `+` for `-or-later`.
const GNU_ID = /(^|[\s()])((?:A|L)?GPL-(?:2\.0|2\.1|3\.0))(\+?)(?=$|[\s()])/g

/**
 * A license text reduced to what it means, for comparison only (#197): case,
 * whitespace, outer parentheses, the file named by `SEE LICENSE IN`, the GNU
 * deprecated ids, and the operand order of a flat `OR` / `AND` list do not
 * count. Anything else (`MIT/X11`, `Apache 2.0`) is compared as written.
 */
export const normalizeLicense = (text: string): string => {
  let value = text.replace(/\s+/g, ' ').trim()
  if (/^SEE LICEN[CS]E IN\b/i.test(value)) return 'SEE LICENSE IN'
  while (wrapped(value)) value = value.slice(1, -1).trim()
  value = value
    .toUpperCase()
    .replace(
      GNU_ID,
      (_all, before: string, id: string, plus: string) =>
        `${before}${id}${plus ? '-OR-LATER' : '-ONLY'}`,
    )
  if (value.includes('(') || value.includes(')')) return value
  const operators = new Set(
    [...value.matchAll(/ (OR|AND) /g)].map((match) => match[1]),
  )
  if (operators.size !== 1) return value
  const [operator] = operators
  return value
    .split(` ${operator} `)
    .map((operand) => operand.trim())
    .sort()
    .join(` ${operator} `)
}

/** Whether two declared licenses (undefined: none) mean the same. */
export const sameLicense = (
  a: string | undefined,
  b: string | undefined,
): boolean => {
  if (a === undefined || b === undefined) return a === b
  return normalizeLicense(a) === normalizeLicense(b)
}
