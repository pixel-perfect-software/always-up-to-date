import fs from 'fs'
import path from 'path'

/** An override that pins a package: the field it lives in, and its range. */
export interface ControllingOverride {
  field: string
  range: string
}

/**
 * The package a top-level override key pins directly, or undefined when the
 * key only reaches a dependency of another package. Accepts npm/pnpm version
 * selectors (`react@^18`), yarn's `**\/` prefix, and rejects pnpm's
 * `parent>child` and yarn's `parent/child` paths.
 */
const overriddenPackage = (key: string): string | undefined => {
  if (key.includes('>')) return undefined

  const pattern = key.startsWith('**/') ? key.slice(3) : key
  const scoped = pattern.startsWith('@')
  const versionAt = pattern.indexOf('@', scoped ? 1 : 0)
  const name = versionAt === -1 ? pattern : pattern.slice(0, versionAt)

  const slashes = name.split('/').length - 1
  return slashes === (scoped ? 1 : 0) ? name : undefined
}

/**
 * The range an override value pins its package to. npm-style `overrides`:
 * a string pins it, except a `$name` reference, which follows the direct
 * dependency's own spec. An object pins it only through its `.` key; its
 * other keys reach dependencies.
 */
const pinnedRange = (value: unknown): string | undefined => {
  if (typeof value === 'string') {
    return value.startsWith('$') ? undefined : value
  }
  if (value && typeof value === 'object' && '.' in value) {
    return pinnedRange((value as Record<string, unknown>)['.'])
  }
  return undefined
}

/**
 * The packages an override field pins, labelled with `label`. Accepts the
 * npm-style object every manager uses: keys are package patterns, values
 * are ranges.
 */
export const overridesFromField = (
  field: unknown,
  label: string,
): Record<string, ControllingOverride> => {
  if (!field || typeof field !== 'object' || Array.isArray(field)) return {}

  const controlled: Record<string, ControllingOverride> = {}
  for (const [key, value] of Object.entries(field)) {
    const name = overriddenPackage(key)
    const range = pinnedRange(value)
    if (name && range) controlled[name] = { field: label, range }
  }
  return controlled
}

/**
 * Overrides from package.json fields, in order: a later field wins for the
 * same package. Nothing when the manifest can't be read.
 */
export const manifestOverrides = (
  cwd: string,
  fields: string[],
): Record<string, ControllingOverride> => {
  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'),
    )
  } catch {
    return {}
  }

  return Object.assign(
    {},
    ...fields.map((field) => overridesFromField(manifest[field], field)),
  )
}
