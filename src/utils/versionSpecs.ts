import fs from 'fs'
import path from 'path'
import semver from 'semver'
import { parseAlias } from './aliasSpec'
import { DEFAULT_SAVE_STYLE, type SaveStyle } from './saveStyle'

/** A `catalog:` or `workspace:` reference: never rewritten. */
export const isWorkspaceReference = (version: string): boolean => {
  return (
    version.startsWith('catalog:') ||
    version.startsWith('workspace:') ||
    version === 'workspace:*'
  )
}

/**
 * Extracts the version decorator from a version string (^, ~, >=, etc.)
 * and returns it along with the clean version number
 */
const parseVersionString = (
  versionString: string,
): { decorator: string; version: string } => {
  // Handle workspace and catalog references
  if (isWorkspaceReference(versionString)) {
    return { decorator: '', version: versionString }
  }

  // Match common version decorators: ^, ~, >=, >, <=, <, =
  const match = versionString.match(/^([~^>=<!]*)(.+)$/)

  if (match) {
    return {
      decorator: match[1] || '',
      version: match[2],
    }
  }

  // Fallback: no decorator found
  return { decorator: '', version: versionString }
}

/**
 * Applies the preserved decorator to a new version
 */
const applyVersionDecorator = (
  decorator: string,
  newVersion: string,
): string => (decorator ? `${decorator}${newVersion}` : newVersion)

/**
 * Builds the manifest spec for a new version:
 * - a single comparator (`^1.2.3`, `~1.2.3`, `1.2.3`) keeps its decorator,
 *   so an exact pin stays exact and no decorator is added
 * - an `npm:` alias keeps the alias and rewrites the spec inside it
 * - a spec that cannot keep its shape (`1.x`, `*`, `>=1 <2`, `^1 || ^2`) is
 *   written the way the project's manager writes a new entry (`style`)
 * - a git, file or URL spec is left alone
 * - with `style.pin`, the bare version (#147)
 */
export const nextVersionSpec = (
  currentSpec: string,
  newVersion: string,
  style: SaveStyle = DEFAULT_SAVE_STYLE,
): string => {
  const alias = parseAlias(currentSpec)
  if (alias) {
    return `npm:${alias.name}@${nextVersionSpec(alias.range, newVersion, style)}`
  }
  if (/[:/#]/.test(currentSpec)) return currentSpec
  if (style.pin) return newVersion

  const { decorator, version } = parseVersionString(currentSpec)
  if (semver.valid(version)) return applyVersionDecorator(decorator, newVersion)
  return style.exact ? newVersion : `${style.prefix}${newVersion}`
}

/** The fields a yarn descriptor can come from, in the order they are looked up. */
const DESCRIPTOR_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const

/**
 * Builds `name@spec` descriptors for a manager that rewrites the manifest
 * itself (yarn `upgrade` / `up`). A package in `newVersions` gets its spec
 * moved to that version, keeping its decorator. A package in `withinRange`
 * keeps its current spec, so yarn resolves the highest version the range
 * allows (a bare `yarn up name` on berry would jump to latest instead).
 * Packages the root manifest does not list are returned separately: handing
 * those to yarn at the root would add them as new root dependencies.
 */
export const buildUpdateDescriptors = (
  cwd: string,
  {
    withinRange = [],
    newVersions = {},
    style = DEFAULT_SAVE_STYLE,
  }: {
    withinRange?: string[]
    newVersions?: Record<string, string>
    style?: SaveStyle
  },
): {
  descriptors: string[]
  notInManifest: string[]
} => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'),
  )

  const descriptors: string[] = []
  const notInManifest: string[] = []

  for (const packageName of [...withinRange, ...Object.keys(newVersions)]) {
    const field = DESCRIPTOR_FIELDS.find((name) => {
      const spec = packageJson?.[name]?.[packageName]
      return typeof spec === 'string' && !isWorkspaceReference(spec)
    })

    if (field) {
      const currentVersion: string = packageJson[field][packageName]
      const newVersion = newVersions[packageName]
      const spec = newVersion
        ? nextVersionSpec(currentVersion, newVersion, style)
        : currentVersion
      descriptors.push(`${packageName}@${spec}`)
    } else {
      notInManifest.push(packageName)
    }
  }

  return { descriptors, notInManifest }
}
