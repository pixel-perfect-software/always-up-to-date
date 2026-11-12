import fs from 'fs'
import path from 'path'
import type { ManifestPlan } from '@/types'
import { DEPENDENCY_FIELDS } from './dependencySpecs'
import { DEFAULT_SAVE_STYLE, type SaveStyle } from './saveStyle'
import { isWorkspaceReference, nextVersionSpec } from './versionSpecs'

/**
 * Serializes `data` the way `original` was written: the same indentation
 * (tabs or a number of spaces), the same line endings, and a final newline
 * only if the file had one. A version bump then changes only its line.
 */
export const formatLike = (original: string, data: unknown): string => {
  const indent = /^([ \t]+)"/m.exec(original)?.[1] ?? '  '
  const eol = original.includes('\r\n') ? '\r\n' : '\n'
  const body = JSON.stringify(data, null, indent).replaceAll('\n', eol)
  return /\r?\n$/.test(original) ? `${body}${eol}` : body
}

/**
 * Moves each named entry to its new version, keeping its decorator, in
 * `dependencies`, `optionalDependencies` and `devDependencies`. A
 * `peerDependencies` range is never written: it is the package's contract
 * with its consumers, and narrowing it would drop them (#155).
 */
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
  /** catalog name (`default` for `catalog:`) → package → new version */
  catalogs: Record<string, Record<string, string>>
  byManifest: { path: string; versions: Record<string, string> }[]
} => {
  const catalogs: Record<string, Record<string, string>> = {}
  const byManifest: { path: string; versions: Record<string, string> }[] = []
  for (const manifest of manifests) {
    const versions: Record<string, string> = {}
    for (const [name, version] of Object.entries(manifest.beyondRange)) {
      const spec = readSpec(path.join(cwd, manifest.path), name)
      if (spec?.startsWith('catalog:')) {
        const reference = spec.slice('catalog:'.length).trim()
        ;(catalogs[reference === '' ? 'default' : reference] ??= {})[name] =
          version
      } else versions[name] = version
    }
    if (Object.keys(versions).length > 0) {
      byManifest.push({ path: manifest.path, versions })
    }
  }
  return { catalogs, byManifest }
}
