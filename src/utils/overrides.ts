import fs from 'fs'
import path from 'path'
import { isYarnBerry } from '@/detectPackageManager'
import type { SupportedPackageManager } from '@/types'

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

const fromField = (
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

/** The `overrides:` block of pnpm-workspace.yaml, read line by line. */
const readWorkspaceOverrides = (cwd: string): Record<string, string> => {
  let lines: string[]
  try {
    lines = fs
      .readFileSync(path.join(cwd, 'pnpm-workspace.yaml'), 'utf8')
      .split('\n')
  } catch {
    return {}
  }

  const overrides: Record<string, string> = {}
  let inBlock = false
  for (const line of lines) {
    if (/^\S/.test(line)) {
      inBlock = /^overrides:\s*$/.test(line)
      continue
    }
    const entry = inBlock
      ? /^\s+(['"]?)(.+?)\1\s*:\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line)
      : null
    if (entry) overrides[entry[2]] = entry[3]
  }
  return overrides
}

/**
 * Packages pinned by an override the current version of the manager
 * enforces, with the field and range that pin them. Such a package resolves
 * within the override's range whatever its manifest says, so an update to a
 * version outside that range cannot take effect:
 * - npm: `overrides`
 * - yarn: `resolutions`, on berry only. Yarn v1 applies them to transitive
 *   dependencies but not to a direct one (verified on 1.22.22: the direct
 *   dependency still moved), so there is nothing to hold
 * - pnpm: `overrides` in pnpm-workspace.yaml (pnpm 12 ignores `pnpm.overrides`
 *   and `resolutions` in package.json)
 * - bun: `overrides` and `resolutions`
 */
export const findControllingOverrides = (
  cwd: string,
  packageManager: SupportedPackageManager,
): Record<string, ControllingOverride> => {
  if (packageManager === 'pnpm') {
    return fromField(
      readWorkspaceOverrides(cwd),
      'overrides in pnpm-workspace.yaml',
    )
  }

  let manifest: Record<string, unknown>
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'),
    )
  } catch {
    return {}
  }

  switch (packageManager) {
    case 'npm':
      return fromField(manifest.overrides, 'overrides')
    case 'yarn':
      return isYarnBerry(cwd)
        ? fromField(manifest.resolutions, 'resolutions')
        : {}
    case 'bun':
      return {
        ...fromField(manifest.overrides, 'overrides'),
        ...fromField(manifest.resolutions, 'resolutions'),
      }
  }
}
