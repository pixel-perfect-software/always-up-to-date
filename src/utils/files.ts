import fs from 'fs'
import path from 'path'
import semver from 'semver'
import type { ManifestPlan } from '@/types'
import { DEPENDENCY_FIELDS } from './manifestNames'
import { DEFAULT_SAVE_STYLE, type SaveStyle } from './saveStyle'

export const checkIfFileExists = (filePath: string): boolean => {
  try {
    // Check if the file exists
    const stats = fs.statSync(filePath)
    // Return true if it is a file
    if (stats.isFile()) return true

    // If it exists but is not a file, return false
    return false
  } catch {
    return false
  }
}

const isWorkspaceReference = (version: string): boolean => {
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
 */
const nextVersionSpec = (
  currentSpec: string,
  newVersion: string,
  style: SaveStyle = DEFAULT_SAVE_STYLE,
): string => {
  const alias = /^npm:((?:@[^/@]+\/)?[^@]+)@(.+)$/.exec(currentSpec)
  if (alias) {
    return `npm:${alias[1]}@${nextVersionSpec(alias[2], newVersion, style)}`
  }
  if (/[:/#]/.test(currentSpec)) return currentSpec

  const { decorator, version } = parseVersionString(currentSpec)
  if (semver.valid(version)) return applyVersionDecorator(decorator, newVersion)
  return style.exact ? newVersion : `${style.prefix}${newVersion}`
}

/**
 * Serializes `data` the way `original` was written: the same indentation
 * (tabs or a number of spaces), the same line endings, and a final newline
 * only if the file had one. A version bump then changes only its line.
 */
const formatLike = (original: string, data: unknown): string => {
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? '  '
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const body = JSON.stringify(data, null, indent).replaceAll('\n', eol)
  return /\r?\n$/.test(original) ? `${body}${eol}` : body
}

/** Moves each named entry to its new version, keeping its decorator. */
export const updatePackageJson = async (
  cwd: string,
  versions: Record<string, string>,
  style: SaveStyle = DEFAULT_SAVE_STYLE,
): Promise<void> => {
  const packageJsonPath = path.join(cwd, 'package.json')
  const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8')

  const packageJson = JSON.parse(packageJsonContent)

  // Update the version of each package in the package.json
  Object.keys(versions).forEach((packageName) => {
    if (packageJson?.dependencies?.[packageName]) {
      const currentVersion = packageJson.dependencies[packageName]
      if (!isWorkspaceReference(currentVersion)) {
        const newVersion = nextVersionSpec(
          currentVersion,
          versions[packageName],
          style,
        )
        packageJson.dependencies[packageName] = newVersion
      }
    }

    if (packageJson?.optionalDependencies?.[packageName]) {
      const currentVersion = packageJson.optionalDependencies[packageName]
      if (!isWorkspaceReference(currentVersion)) {
        const newVersion = nextVersionSpec(
          currentVersion,
          versions[packageName],
          style,
        )
        packageJson.optionalDependencies[packageName] = newVersion
      }
    }

    if (packageJson?.peerDependencies?.[packageName]) {
      const currentVersion = packageJson.peerDependencies[packageName]
      if (!isWorkspaceReference(currentVersion)) {
        const newVersion = nextVersionSpec(
          currentVersion,
          versions[packageName],
          style,
        )
        packageJson.peerDependencies[packageName] = newVersion
      }
    }

    if (packageJson?.devDependencies?.[packageName]) {
      const currentVersion = packageJson.devDependencies[packageName]
      if (!isWorkspaceReference(currentVersion)) {
        const newVersion = nextVersionSpec(
          currentVersion,
          versions[packageName],
          style,
        )
        packageJson.devDependencies[packageName] = newVersion
      }
    }
  })

  fs.writeFileSync(
    packageJsonPath,
    formatLike(packageJsonContent, packageJson),
    'utf8',
  )
}

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
): { descriptors: string[]; notInManifest: string[] } => {
  const packageJson = JSON.parse(
    fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'),
  )

  const descriptors: string[] = []
  const notInManifest: string[] = []

  for (const packageName of [...withinRange, ...Object.keys(newVersions)]) {
    const currentVersion = [
      packageJson?.dependencies?.[packageName],
      packageJson?.devDependencies?.[packageName],
      packageJson?.optionalDependencies?.[packageName],
    ].find(
      (spec): spec is string =>
        typeof spec === 'string' && !isWorkspaceReference(spec),
    )

    if (currentVersion) {
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

/**
 * A `name: version` entry: indent, the name with its quotes, the separator,
 * the version with its quotes, and whatever follows (a comment).
 */
const YAML_ENTRY =
  /^(\s+)(['"]?)([^'"\s#][^'"\s]*)\2(\s*:\s*)(['"]?)([^'"\s#]+)\5(.*)$/

/**
 * Rewrites catalog versions in pnpm-workspace.yaml: the entries under
 * `catalog:` and under each named catalog in `catalogs:`. Every other block
 * (`overrides`, `peerDependencyRules`, …) and every other line stays as it
 * was, and an entry keeps its quotes and trailing comment.
 */
export const updatePNPMWorkspaceYAML = async (
  cwd: string,
  versions: Record<string, string>,
  style: SaveStyle = DEFAULT_SAVE_STYLE,
): Promise<void> => {
  const pnpmWorkspaceYamlPath = path.join(cwd, 'pnpm-workspace.yaml')
  const lines = fs.readFileSync(pnpmWorkspaceYamlPath, 'utf8').split('\n')

  // The top-level key the current line sits under, and, inside `catalogs:`,
  // the indent of the named catalog it belongs to.
  let block: string | undefined
  let catalogIndent: number | undefined

  const updatedLines = lines.map((line) => {
    if (/^\S/.test(line)) {
      if (!line.startsWith('#')) {
        block = /^(['"]?)([^'"\s:]+)\1\s*:/.exec(line)?.[2]
        catalogIndent = undefined
      }
      return line
    }
    if (block !== 'catalog' && block !== 'catalogs') return line
    if (/^\s*(#|$)/.test(line)) return line

    if (block === 'catalogs') {
      const catalogKey = /^(\s+)(['"]?)[^'"\s:]+\2\s*:\s*(#.*)?$/.exec(line)
      if (catalogKey) {
        catalogIndent = catalogKey[1].length
        return line
      }
    }

    const entry = YAML_ENTRY.exec(line)
    if (!entry) return line
    const [, indent, keyQuote, name, separator, quote, spec, rest] = entry
    if (
      block === 'catalogs' &&
      !(indent.length > (catalogIndent ?? Infinity))
    ) {
      return line
    }
    if (!Object.hasOwn(versions, name)) return line

    const newSpec = nextVersionSpec(spec, versions[name], style)
    return `${indent}${keyQuote}${name}${keyQuote}${separator}${quote}${newSpec}${quote}${rest}`
  })

  fs.writeFileSync(pnpmWorkspaceYamlPath, updatedLines.join('\n'), 'utf8')
}

export const updateBunCatalogs = async (
  cwd: string,
  versions: Record<string, string>,
  style: SaveStyle = DEFAULT_SAVE_STYLE,
): Promise<void> => {
  const packageJsonPath = path.join(cwd, 'package.json')
  const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8')
  const packageJson = JSON.parse(packageJsonContent)

  let catalogsUpdated = false

  // Handle the default "catalog" field (singular)
  if (packageJson.catalog && typeof packageJson.catalog === 'object') {
    for (const packageName of Object.keys(versions)) {
      if (packageJson.catalog[packageName]) {
        const currentVersion = packageJson.catalog[packageName]
        const targetVersion = versions[packageName]

        const newVersion = nextVersionSpec(currentVersion, targetVersion, style)

        // Update the catalog entry
        packageJson.catalog[packageName] = newVersion
        catalogsUpdated = true
      }
    }
  }

  // Handle named catalogs (plural)
  if (packageJson.catalogs && typeof packageJson.catalogs === 'object') {
    // Iterate through each catalog (e.g., "repo", "types", "ui")
    for (const catalogName of Object.keys(packageJson.catalogs)) {
      const catalog = packageJson.catalogs[catalogName]

      if (!catalog || typeof catalog !== 'object') {
        continue
      }

      // Update packages in this catalog
      for (const packageName of Object.keys(versions)) {
        if (catalog[packageName]) {
          const currentVersion = catalog[packageName]
          const targetVersion = versions[packageName]

          const newVersion = nextVersionSpec(
            currentVersion,
            targetVersion,
            style,
          )

          // Update the catalog entry
          packageJson.catalogs[catalogName][packageName] = newVersion
          catalogsUpdated = true
        }
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

/**
 * The spec the manifest in `dir` declares for `name`, from the first
 * dependency field that lists it. Undefined when the manifest can't be read
 * or doesn't declare the package.
 */
export const readSpec = (dir: string, name: string): string | undefined => {
  let manifest: Record<string, Record<string, unknown> | undefined>
  try {
    manifest = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    )
  } catch {
    return undefined
  }
  for (const field of DEPENDENCY_FIELDS) {
    const spec = manifest[field]?.[name]
    if (typeof spec === 'string') return spec
  }
  return undefined
}

/**
 * Sorts the beyond-range writes of a workspace plan by where the version
 * lives: a manifest whose spec is `catalog:` reads its version from the
 * catalog, so the move is a catalog write; every other row is written into
 * the manifest that owns it. The same package can be both, in different
 * manifests.
 */
export const splitCatalogUpdates = (
  cwd: string,
  manifests: ManifestPlan[],
): {
  catalog: Record<string, string>
  byManifest: { path: string; versions: Record<string, string> }[]
} => {
  const catalog: Record<string, string> = {}
  const byManifest: { path: string; versions: Record<string, string> }[] = []
  for (const manifest of manifests) {
    const versions: Record<string, string> = {}
    for (const [name, version] of Object.entries(manifest.beyondRange)) {
      const spec = readSpec(path.join(cwd, manifest.path), name)
      if (spec?.startsWith('catalog:')) catalog[name] = version
      else versions[name] = version
    }
    if (Object.keys(versions).length > 0) {
      byManifest.push({ path: manifest.path, versions })
    }
  }
  return { catalog, byManifest }
}
