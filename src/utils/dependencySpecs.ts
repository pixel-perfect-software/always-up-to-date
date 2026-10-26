import fs from 'fs'
import path from 'path'
import semver from 'semver'
import type { WorkspaceManifest } from '@/managers/adapter'
import { StepError } from '@/stepError'
import { parseAlias, parseBareAlias } from './aliasSpec'
import logger from './logger'

export const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
] as const

/**
 * The fields discovery looks at, in `readSpec`'s order. A name declared only
 * in `peerDependencies` is not discovered: a peer range is the package's
 * contract with its consumers.
 */
export const DISCOVERED_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const

/** Catalog entries by catalog name (`default` for `catalog:`), name → spec. */
export type Catalogs = Record<string, Record<string, string>>

/** What a registry dependency asks for: a semver range, or the `latest` dist-tag. */
export type DependencySpec = { range: string } | { tag: 'latest' }

export type ClassifiedSpec =
  | { kind: 'registry'; name: string; spec: DependencySpec }
  | {
      kind: 'skipped'
      reason: string
      /** The spec would otherwise read as up to date, so say so above debug level. */
      warn: boolean
    }

const skip = (reason: string, warn = false): ClassifiedSpec => ({
  kind: 'skipped',
  reason,
  warn,
})

const classifyResolved = (key: string, spec: string): ClassifiedSpec => {
  if (spec.startsWith('workspace:')) return skip(`workspace spec "${spec}"`)

  let name = key
  let range = spec.trim()
  // npm reads `npm:<name>` as `npm:<name>@latest`.
  const bare = parseBareAlias(range)
  if (bare) return { kind: 'registry', name: bare, spec: { tag: 'latest' } }
  const alias = parseAlias(range)
  if (alias) {
    name = alias.name
    range = alias.range.trim()
  }

  if (/[:/#]/.test(range)) {
    return skip(`"${spec}" does not come from the registry`)
  }
  if (range === 'latest')
    return { kind: 'registry', name, spec: { tag: 'latest' } }
  if (range !== '' && semver.validRange(range) === null) {
    return skip(
      `"${spec}" is not a version range (autd follows only the "latest" dist-tag)`,
      true,
    )
  }
  return { kind: 'registry', name, spec: { range: range === '' ? '*' : range } }
}

/**
 * Decides what to do with the spec a manifest declares for `key`:
 * 1. `catalog:` / `catalog:<name>` resolves to the catalog's entry (`''` and
 *    `default` are the default catalog); an unknown entry is skipped with a
 *    warning,
 * 2. `workspace:` is skipped,
 * 3. an `npm:<target>@<range>` alias is looked up by its target,
 * 4. anything still holding `:`, `/` or `#` (git, file, link, URL, github
 *    shorthand) is skipped; a bare `npm:<name>` is `latest` of that name,
 * 5. `latest` is the dist-tag,
 * 6. a spec that is not a valid range (another dist-tag) is skipped with a
 *    warning,
 * 7. any other is a registry range; `''` is `*`.
 */
export const classifySpec = (
  key: string,
  spec: string,
  catalogs: Catalogs,
): ClassifiedSpec => {
  if (spec.startsWith('catalog:')) {
    const reference = spec.slice('catalog:'.length).trim()
    const catalog = reference === '' ? 'default' : reference
    const entry = catalogs[catalog]?.[key]
    if (entry === undefined) {
      return skip(`${spec} has no entry for ${key}`, true)
    }
    return classifyResolved(key, entry)
  }
  return classifyResolved(key, spec)
}

export interface DeclaredDependency {
  /** The manifest's directory relative to the root; '.' is the root. */
  workspace: string
  /** The manifest key (an alias's own name). */
  key: string
  /** What is looked up: the key, or an alias's target. */
  name: string
  field: (typeof DISCOVERED_FIELDS)[number]
  spec: DependencySpec
}

const manifestFile = (workspace: string): string =>
  workspace === '.' ? 'package.json' : `${workspace}/package.json`

const readManifestFile = (
  cwd: string,
  workspace: string,
): Record<string, unknown> => {
  const label = manifestFile(workspace)
  let manifest: unknown
  try {
    manifest = JSON.parse(
      fs.readFileSync(
        path.join(cwd, ...workspace.split('/'), 'package.json'),
        'utf8',
      ),
    )
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new StepError('discover', `${label} can't be read: ${reason}`, {
      cause: error,
    })
  }
  if (
    typeof manifest !== 'object' ||
    manifest === null ||
    Array.isArray(manifest)
  ) {
    throw new StepError('discover', `${label} can't be read: not a JSON object`)
  }
  return manifest as Record<string, unknown>
}

/**
 * The registry dependencies every manifest declares: the root first, then the
 * members, as `manifests` lists them; per manifest the fields of
 * `DISCOVERED_FIELDS` in order, and a name in several fields is read from the
 * first. Specs that never reach the registry are left out, each with a debug
 * line (a warning when they would otherwise read as up to date).
 *
 * A manifest that can't be read or parsed throws a `discover` `StepError`:
 * it must never read as "nothing outdated".
 */
export const readDeclaredDependencies = (
  cwd: string,
  {
    manifests,
    catalogs,
  }: { manifests: WorkspaceManifest[]; catalogs: Catalogs },
): DeclaredDependency[] => {
  const declared: DeclaredDependency[] = []
  for (const { path: workspace } of manifests) {
    const manifest = readManifestFile(cwd, workspace)
    const seen = new Set<string>()
    for (const field of DISCOVERED_FIELDS) {
      const entries = manifest[field]
      if (typeof entries !== 'object' || entries === null) continue
      for (const [key, spec] of Object.entries(entries)) {
        if (typeof spec !== 'string' || seen.has(key)) continue
        seen.add(key)
        const classified = classifySpec(key, spec, catalogs)
        if (classified.kind === 'skipped') {
          const line = `${manifestFile(workspace)}: skipping ${key}: ${classified.reason}`
          if (classified.warn) logger.warn(line)
          else logger.debug(line)
          continue
        }
        declared.push({
          workspace,
          key,
          name: classified.name,
          field,
          spec: classified.spec,
        })
      }
    }
  }
  return declared
}
