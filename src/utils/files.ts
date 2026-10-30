import fs from 'fs'
import path from 'path'
import semver from 'semver'
import type { ManifestPlan } from '@/types'
import { parseAlias } from './aliasSpec'
import { DEPENDENCY_FIELDS } from './dependencySpecs'
import { isRecord } from './isRecord'
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
 * - with `style.pin`, the bare version (#147)
 */
const nextVersionSpec = (
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
 * Builds `name@spec` descriptors for a manager that rewrites the manifest
 * itself (yarn `upgrade` / `up`). A package in `newVersions` gets its spec
 * moved to that version, keeping its decorator. A package in `withinRange`
 * keeps its current spec, so yarn resolves the highest version the range
 * allows (a bare `yarn up name` on berry would jump to latest instead).
 * Packages the root manifest does not list are returned separately: handing
 * those to yarn at the root would add them as new root dependencies.
 */
/** The fields a yarn descriptor can come from, in the order they are looked up. */
const DESCRIPTOR_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const

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
 * Walks the catalog entries of pnpm-workspace.yaml, the ones under `catalog:`
 * (the `default` catalog) and under each named catalog in `catalogs:`, and
 * returns the text with each entry `visit` answers for rewritten. `visit`
 * gets the catalog's name, the entry's name and its spec; a spec it returns
 * replaces the entry's, `undefined` leaves the line alone. Every other block
 * (`overrides`, `peerDependencyRules`, …) and every other line stays as it
 * was, and an entry keeps its quotes and trailing comment. The writer and
 * `readPnpmCatalogs` share this walk, so they agree on what an entry is.
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

  const rewriteLine = (line: string): string => {
    if (/^\S/.test(line)) {
      if (!line.startsWith('#')) {
        block = /^(['"]?)([^'"\s:]+)\1\s*:/.exec(line)?.[2]
        catalogIndent = undefined
        catalogName = undefined
      }
      return line
    }
    if (block !== 'catalog' && block !== 'catalogs') return line
    if (/^\s*(#|$)/.test(line)) return line

    if (block === 'catalogs') {
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

  // A CRLF file keeps its `\r`: the line is rewritten without it and gets it back.
  return text
    .split('\n')
    .map((line) =>
      line.endsWith('\r')
        ? `${rewriteLine(line.slice(0, -1))}\r`
        : rewriteLine(line),
    )
    .join('\n')
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
 * for `catalogs: default:`), read by the walk the writer uses.
 */
export const readPnpmCatalogs = (
  yaml: string,
): Record<string, Record<string, string>> => {
  const catalogs: Record<string, Record<string, string>> = {}
  mapPnpmCatalogEntries(yaml, (catalog, name, spec) => {
    ;(catalogs[catalog] ??= {})[name] = spec
    return undefined
  })
  return catalogs
}

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
