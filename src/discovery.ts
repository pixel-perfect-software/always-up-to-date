import fs from 'fs'
import path from 'path'
import semver from 'semver'
import type { Discovery, Workspace } from '@/managers/adapter'
import { StepError } from '@/stepError'
import type {
  OutdatedEntry,
  PackageInfo,
  PackageLookup,
  SupportedPackageManager,
} from '@/types'
import {
  type DeclaredDependency,
  readDeclaredDependencies,
} from '@/utils/dependencySpecs'
import {
  type InstalledPackage,
  readInstalledPackages,
  rowKey,
} from '@/utils/installed'
import logger from '@/utils/logger'
import type { RegistrySession } from '@/utils/registry'
import { wantedVersion } from '@/utils/wanted'
import { byPath } from '@/utils/workspaceRows'

export interface RegistryDiscoveryInput {
  cwd: string
  /** Names the install command in the "nothing installed" message. */
  manager: SupportedPackageManager
  workspace: Workspace
  registry: Pick<RegistrySession, 'lookup'>
  /**
   * Installed copies by `rowKey`; default `readInstalledPackages`
   * (node_modules). A lockfile reader goes here (#107).
   */
  readInstalled?: (
    cwd: string,
    rows: { name: string; workspace?: string }[],
  ) => Record<string, InstalledPackage>
}

/** Failed lookups named in one error: past this many, the rest are counted. */
const MAX_NAMED_FAILURES = 10

const failureError = (
  failures: Extract<PackageLookup, { ok: false }>[],
): StepError => {
  const named = failures
    .slice(0, MAX_NAMED_FAILURES)
    .map(({ name, reason }) => `  ${name}: ${reason}`)
  const more = failures.length - named.length
  return new StepError(
    'discover',
    [
      `The registry lookup failed for ${failures.length} ${failures.length === 1 ? 'package' : 'packages'}:`,
      ...named,
      ...(more > 0 ? [`  and ${more} more`] : []),
    ].join('\n'),
  )
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name === b.name ? 0 : a.name < b.name ? -1 : 1

/**
 * Finds the outdated packages of npm, pnpm, yarn v1 and bun with no
 * subprocess: the manifests say what is declared, node_modules what is
 * installed, and the registry reader what is published. Every manager gets
 * the same `wanted` rule, computed for the manifest that declares the
 * package. A package is listed when it is missing, or `latest` or `wanted`
 * is ahead of what is installed.
 *
 * A lookup that fails fails the run, after every lookup has settled: a
 * package left out would read as up to date.
 */
export const discoverFromRegistry = async ({
  cwd,
  manager,
  workspace,
  registry,
  readInstalled = readInstalledPackages,
}: RegistryDiscoveryInput): Promise<Discovery> => {
  const declared = readDeclaredDependencies(cwd, workspace)

  if (
    declared.length > 0 &&
    readInstalled === readInstalledPackages &&
    !fs.existsSync(path.join(cwd, 'node_modules'))
  ) {
    throw new StepError(
      'discover',
      `Nothing is installed in ${cwd} (no node_modules): run \`${manager} install\`, then check again.`,
    )
  }

  const rowFor = ({ key, workspace: member }: DeclaredDependency) => ({
    name: key,
    workspace: workspace.isWorkspace ? member : undefined,
  })
  const installed = readInstalled(cwd, declared.map(rowFor))
  const memberNames = new Set(
    workspace.manifests.flatMap((manifest) =>
      manifest.name === undefined ? [] : [manifest.name],
    ),
  )

  // What is left to look up. A workspace package or link is not on the
  // registry (a private member's name would 404 and fail the run), so it is
  // skipped before any request.
  const active = declared.filter((dependency) => {
    const { key, field } = dependency
    const label = `${dependency.workspace === '.' ? '' : `${dependency.workspace}: `}${key}`
    const found = installed[rowKey(rowFor(dependency))]
    if (found?.linked || (!found && memberNames.has(key))) {
      logger.debug(`Skipping ${label}: a workspace package or link`)
      return false
    }
    if (!found && field === 'optionalDependencies') {
      logger.debug(`Skipping ${label}: optional and not installed`)
      return false
    }
    return true
  })

  const started = Date.now()
  const names = [...new Set(active.map((dependency) => dependency.name))].sort()
  const lookups = names.map((name) => registry.lookup(name))

  const results = await Promise.all(lookups)
  const failures = results.filter(
    (result): result is Extract<PackageLookup, { ok: false }> => !result.ok,
  )
  if (failures.length > 0) throw failureError(failures)

  const packages = new Map(
    results.flatMap((result, index) =>
      result.ok ? [[names[index], result.package] as const] : [],
    ),
  )
  const fromDepsDev = [...packages.values()].filter(
    (pkg) => pkg.source === 'deps.dev',
  ).length
  logger.debug(
    `Looked up ${names.length} packages in ${Date.now() - started} ms (${fromDepsDev} from deps.dev, ${packages.size - fromDepsDev} from a packument)`,
  )

  const entries: OutdatedEntry[] = []
  for (const dependency of active) {
    const { key, spec } = dependency
    const found = installed[rowKey(rowFor(dependency))]
    const pkg = packages.get(dependency.name)
    if (!pkg) continue
    const current = found?.version ?? 'missing'
    const wanted =
      'tag' in spec ? pkg.latest : (wantedVersion(spec.range, pkg) ?? current)

    const behind = (version: string): boolean =>
      semver.valid(current) === null || semver.gt(version, current)
    if (behind(pkg.latest) || behind(wanted)) {
      entries.push({
        name: key,
        current,
        wanted,
        latest: pkg.latest,
        workspace: dependency.workspace,
      })
    }
  }

  if (!workspace.isWorkspace) {
    const outdated: Record<string, PackageInfo> = {}
    for (const { name, current, wanted, latest } of entries.sort(byName)) {
      outdated[name] = { name, current, wanted, latest }
    }
    return { kind: 'single', outdated }
  }
  return {
    kind: 'workspace',
    entries: entries.sort(
      (a, b) =>
        byName(a, b) || byPath({ path: a.workspace }, { path: b.workspace }),
    ),
  }
}
