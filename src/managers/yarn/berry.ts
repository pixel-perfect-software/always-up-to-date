import fs from 'fs'
import path from 'path'
import semver from 'semver'

import type {
  Discovery,
  RunManager,
  WorkspaceManifest,
} from '@/managers/adapter'
import {
  listsMember,
  ownerPath,
  packageJsonWorkspaceRoot,
  toPosix,
} from '@/managers/workspaces'
import { type PipelineStep, StepError } from '@/stepError'
import type { ManifestPlan, OutdatedEntry, PackageInfo } from '@/types'
import { parseAlias } from '@/utils/aliasSpec'
import { updatePackageJson } from '@/utils/files'
import { rowKey } from '@/utils/installed'
import { isRecord } from '@/utils/isRecord'
import type { SaveStyle } from '@/utils/saveStyle'
import { byPath } from '@/utils/workspaceRows'

/**
 * Yarn 2+ ("berry") has no `outdated`. Discovery reads what each workspace
 * declares and has locked from `yarn info -A --json`, then asks the registry
 * (through `yarn npm info`, so .yarnrc.yml's registries and auth apply) for
 * the published versions. `wanted` and `latest` are worked out here.
 */

/** One dependency a workspace declares, with the version the lockfile holds. */
export interface BerryDependency {
  /** The key the workspace's package.json declares it under. */
  key: string
  /** The package on the registry; differs from `key` for an `npm:` alias. */
  name: string
  /** The manifest range. */
  range: string
  /** The locked version. */
  current: string
}

/** One workspace of the project, `path` relative to the root ('.' is the root). */
export interface BerryWorkspace {
  path: string
  dependencies: BerryDependency[]
}

/** What the registry publishes for one package. */
export interface RegistryPackage {
  latest?: string
  versions: string[]
}

/** Names per `yarn npm info` call. */
const REGISTRY_BATCH = 50

/** Splits `<name>@<reference>`; a scope's leading `@` is part of the name. */
const splitIdent = (
  ident: string,
): { name: string; reference: string } | undefined => {
  const at = ident.indexOf('@', 1)
  return at === -1
    ? undefined
    : { name: ident.slice(0, at), reference: ident.slice(at + 1) }
}

/** The `npm:` range or version a descriptor or locator reference holds. */
const npmSpec = (
  name: string,
  reference: string,
): { name: string; spec: string } | undefined => {
  // A peer-dependent package: `virtual:<hash>#npm:~4.3.1`. Yarn appends
  // `::key=value` parameters to some locators (`::__archiveUrl=…` for a
  // registry with nonstandard tarball URLs, `::version=…` on patches).
  const real = reference.replace(/^virtual:[^#]*#/, '').replace(/::.*$/, '')

  // A builtin patch (typescript, fsevents, resolve):
  // `patch:typescript@npm%3A^5.4.0#optional!builtin<compat/typescript>`.
  if (real.startsWith('patch:')) {
    const [target, patch = ''] = real.slice('patch:'.length).split('#')
    if (!patch.includes('builtin<')) return undefined
    const inner = splitIdent(decodeURIComponent(target))
    return inner ? npmSpec(inner.name, inner.reference) : undefined
  }

  if (!real.startsWith('npm:')) return undefined
  const alias = parseAlias(real)
  return alias
    ? { name: alias.name, spec: alias.range }
    : { name, spec: real.slice('npm:'.length) }
}

const parseLines = (
  output: string,
  what: string,
  step: PipelineStep = 'discover',
): unknown[] =>
  output
    .split('\n')
    .filter((line) => line.trim())
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch (error) {
        throw new StepError(step, `${what} printed a line it can't read`, {
          cause: error,
        })
      }
    })

/**
 * `yarn info -A --json` (NDJSON): every workspace is an entry whose value is
 * `<name>@workspace:<path>`, with its dependencies as `{ descriptor, locator }`
 * pairs. Packages are the other entries, which are not needed. A dependency
 * that is not an npm range (`workspace:`, `portal:`, `link:`, a git URL) is
 * left out.
 */
export const parseBerryInfo = (
  output: string,
  step: PipelineStep = 'discover',
): BerryWorkspace[] => {
  const workspaces: BerryWorkspace[] = []

  for (const line of parseLines(
    output,
    step === 'discover' ? 'yarn info' : `yarn info (after ${step})`,
    step,
  )) {
    if (!isRecord(line) || typeof line.value !== 'string') continue
    const member = /^.+?@workspace:(.*)$/.exec(line.value)
    if (!member) continue

    const listed = isRecord(line.children) ? line.children.Dependencies : []
    const dependencies: BerryDependency[] = []
    for (const entry of Array.isArray(listed) ? listed : []) {
      if (
        !isRecord(entry) ||
        typeof entry.descriptor !== 'string' ||
        typeof entry.locator !== 'string'
      ) {
        continue
      }
      const descriptor = splitIdent(entry.descriptor)
      const locator = splitIdent(entry.locator)
      if (!descriptor || !locator) continue

      const declared = npmSpec(descriptor.name, descriptor.reference)
      const locked = npmSpec(locator.name, locator.reference)
      if (!declared || !locked) continue
      dependencies.push({
        key: descriptor.name,
        name: declared.name,
        range: declared.spec,
        current: locked.spec,
      })
    }

    workspaces.push({
      path: ownerPath('yarn', line.value, member[1]),
      dependencies,
    })
  }

  return workspaces
}

/**
 * `yarn npm info <names…> --fields dist-tags,versions --json`: one JSON line
 * per package.
 */
export const parseBerryRegistry = (
  output: string,
): Map<string, RegistryPackage> => {
  const packages = new Map<string, RegistryPackage>()
  for (const line of parseLines(output, 'yarn npm info')) {
    if (!isRecord(line) || typeof line.name !== 'string') continue
    const tags = line['dist-tags']
    const latest = isRecord(tags) ? tags.latest : undefined
    packages.set(line.name, {
      latest: typeof latest === 'string' ? latest : undefined,
      versions: Array.isArray(line.versions)
        ? line.versions.filter(
            (version): version is string => typeof version === 'string',
          )
        : [],
    })
  }
  return packages
}

/**
 * The dependency as `PackageInfo` when it is outdated: `wanted` is the highest
 * published version the range allows (prereleases only when the range names
 * one, as npm does), `latest` the registry's `latest` tag. A dependency whose
 * range or locked version is not semver cannot be compared and is left out.
 */
const outdatedInfo = (
  dependency: BerryDependency,
  published: RegistryPackage,
): PackageInfo | undefined => {
  const { key, range, current } = dependency
  if (!semver.valid(current) || !semver.validRange(range)) return undefined

  const allowed = semver.maxSatisfying(published.versions, range)
  const wanted = allowed && semver.gt(allowed, current) ? allowed : current
  const latest =
    published.latest && semver.valid(published.latest)
      ? published.latest
      : wanted

  if (!semver.gt(latest, current) && !semver.gt(wanted, current)) {
    return undefined
  }
  return { name: key, current, wanted, latest }
}

const fetchRegistry = async (
  run: RunManager,
  names: string[],
): Promise<Map<string, RegistryPackage>> => {
  const batches: string[][] = []
  for (let i = 0; i < names.length; i += REGISTRY_BATCH) {
    batches.push(names.slice(i, i + REGISTRY_BATCH))
  }
  // Each batch is its own yarn process and registry round trip.
  const outputs = await Promise.all(
    batches.map((batch) =>
      run([
        'npm',
        'info',
        ...batch,
        '--fields',
        'dist-tags,versions',
        '--json',
      ]),
    ),
  )
  const packages = new Map<string, RegistryPackage>()
  for (const output of outputs) {
    for (const [name, published] of parseBerryRegistry(output)) {
      packages.set(name, published)
    }
  }
  return packages
}

/**
 * The outdated dependencies of every workspace in `workspaces`, from one
 * registry lookup. A name the registry did not answer for fails discovery.
 */
const outdatedByWorkspace = async (
  run: RunManager,
  workspaces: BerryWorkspace[],
): Promise<{ path: string; outdated: PackageInfo[] }[]> => {
  const names = [
    ...new Set(
      workspaces.flatMap((workspace) =>
        workspace.dependencies.map((dependency) => dependency.name),
      ),
    ),
  ].sort()
  const registry =
    names.length > 0 ? await fetchRegistry(run, names) : new Map()

  return workspaces.map((workspace) => ({
    path: workspace.path,
    outdated: workspace.dependencies.flatMap((dependency) => {
      const published = registry.get(dependency.name)
      if (!published) {
        throw new StepError(
          'discover',
          `yarn npm info printed nothing for ${dependency.name}`,
        )
      }
      const info = outdatedInfo(dependency, published)
      return info ? [info] : []
    }),
  }))
}

/**
 * Discovery for berry: a single-package project reads the root workspace, a
 * workspace project every workspace with its path as the owner. A member run
 * (#123) keeps only that member's workspace.
 */
export const discoverBerry = async (
  run: RunManager,
  isWorkspace: boolean,
  member?: WorkspaceManifest,
): Promise<Discovery> => {
  const listed = parseBerryInfo(await run(['info', '-A', '--json']))
  const workspaces = member
    ? listed.filter((workspace) => workspace.path === member.path)
    : isWorkspace
      ? listed
      : listed.filter((workspace) => workspace.path === '.')
  // Every project has at least its root workspace; none means the output
  // wasn't understood, which must not read as "up to date".
  if (workspaces.length === 0) {
    throw new StepError(
      'discover',
      member
        ? `yarn info -A --json listed no workspace at ${member.path}`
        : isWorkspace
          ? 'yarn info -A --json listed no workspaces'
          : 'yarn info -A --json listed no root workspace',
    )
  }

  const found = await outdatedByWorkspace(run, workspaces)

  if (!isWorkspace && !member) {
    return {
      kind: 'single',
      outdated: Object.fromEntries(
        found.flatMap(({ outdated }) =>
          outdated.map((info) => [info.name, info] as const),
        ),
      ),
    }
  }
  return {
    kind: 'workspace',
    entries: found
      .flatMap(({ path: workspace, outdated }) =>
        outdated.map(
          ({ name, current, wanted, latest }): OutdatedEntry => ({
            name,
            current,
            wanted,
            latest,
            workspace,
          }),
        ),
      )
      // By name, then root first: the order yarn v1's table has.
      .sort((a, b) =>
        a.name === b.name
          ? byPath({ path: a.workspace }, { path: b.workspace })
          : a.name < b.name
            ? -1
            : 1,
      ),
  }
}

/**
 * Berry apply. A package moving past its range gets its spec written into the
 * manifest that owns it, then `install` locks it. `up` with explicit
 * descriptors would set that range in every workspace using the package, so
 * in-range packages go to `up -R <names>` instead: it re-resolves them to the
 * highest version their existing ranges allow, project-wide, and leaves every
 * package.json alone.
 */
export const applyBerry = async (
  run: RunManager,
  cwd: string,
  plan: { withinRange: string[]; manifests: ManifestPlan[] },
  style: SaveStyle,
): Promise<void> => {
  const written = plan.manifests.filter(
    (manifest) => Object.keys(manifest.beyondRange).length > 0,
  )
  for (const manifest of written) {
    await updatePackageJson(
      path.join(cwd, manifest.path),
      manifest.beyondRange,
      style,
    )
  }
  // `--no-immutable`: on CI yarn refuses an install that changes yarn.lock,
  // which is the point here.
  if (written.length > 0) {
    await run(['install', '--no-immutable'], { manifestWritten: true })
  }

  if (plan.withinRange.length > 0) {
    await run(['up', '-R', ...plan.withinRange], {
      manifestWritten: written.length > 0,
    })
  }
}

/**
 * The versions yarn locked after apply, from `yarn info -A --json` (PnP has
 * no node_modules to read), keyed by `rowKey`.
 */
export const installedBerry = async (
  run: RunManager,
  rows: { name: string; workspace?: string }[],
): Promise<Record<string, string>> => {
  const workspaces = parseBerryInfo(
    await run(['info', '-A', '--json']),
    'apply',
  )

  const installed: Record<string, string> = {}
  for (const row of rows) {
    const version = workspaces
      .find((workspace) => workspace.path === (row.workspace ?? '.'))
      ?.dependencies.find((dependency) => dependency.key === row.name)?.current
    if (version !== undefined) installed[rowKey(row)] = version
  }
  return installed
}

/**
 * The nearest directory at or above `dir` with a yarn.lock (yarn's
 * `findProjectCwd`), else the nearest ancestor whose `workspaces` list `dir`,
 * else `dir`.
 */
export const yarnProjectDir = (dir: string): string => {
  const start = path.resolve(dir)
  for (let at = start; ; at = path.dirname(at)) {
    if (fs.existsSync(path.join(at, 'yarn.lock'))) return at
    if (path.dirname(at) === at) return packageJsonWorkspaceRoot(start)
  }
}

/**
 * Berry's project for `dir`: its root (\`yarnProjectDir\`). From a directory
 * the root's \`workspaces\` do not list berry fails, "Usage Error: The
 * nearest package directory … doesn't seem to be part of the project", so
 * this does too, before any command runs.
 */
export const berryProjectRoot = (dir: string): string => {
  const start = path.resolve(dir)
  const root = yarnProjectDir(start)
  if (root === start || listsMember(root, start)) return root
  throw new StepError(
    'detect',
    `${toPosix(path.relative(root, start))} is not listed in "workspaces" of ${path.join(root, 'package.json')}, so yarn does not treat it as part of that project. Add it to "workspaces", or run autd from ${root}.`,
  )
}
