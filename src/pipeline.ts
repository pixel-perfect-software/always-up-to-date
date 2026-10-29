import CommandRunner from '@/commandRunner'
import { discoverFromRegistry } from '@/discovery'
import type { ManagerAdapter, RunManager, Workspace } from '@/managers'
import { applyPinned } from '@/managers/pin'
import type { Project } from '@/project'
import type { PipelineStep } from '@/stepError'
import type { PackageInfo, UpdateResult } from '@/types'
import { filterPackages, logger, splitUpdates } from '@/utils'
import { type Catalogs, declaredRange } from '@/utils/dependencySpecs'
import { checkApplied, readInstalledVersions } from '@/utils/installed'
import { foldWorkspaceEntries } from '@/utils/workspaceRows'

const runner = new CommandRunner()

/** The adapter's `run` for one step: failures carry the step's name. */
const runFor =
  (adapter: ManagerAdapter, cwd: string, step: PipelineStep): RunManager =>
  (args, options) =>
    runner.runStep(step, adapter.name, args, cwd, options)

const readWorkspace = (adapter: ManagerAdapter, cwd: string): Workspace => {
  const workspace = adapter.readWorkspace(cwd)
  const catalogs = Object.keys(workspace.catalogs)
  // A pnpm workspace listing only "." is one package: nothing to announce.
  if (workspace.isWorkspace && workspace.manifests.length > 1) {
    logger.workspace(adapter.name, workspace.manifests.length, catalogs.length)
  }
  if (catalogs.length > 0) logger.debug(`catalogs: ${catalogs.join(', ')}`)
  return workspace
}

/**
 * detect → discover: the outdated packages keyed by their package.json
 * names. Nothing is listed here; the report groups them by outcome once
 * they are planned. Discovery reads the manifests,
 * node_modules and the registry, with no manager subprocess; yarn berry
 * alone discovers through the manager.
 */
const discover = async ({
  adapter,
  cwd,
  registry,
}: Project): Promise<{
  outdated: Record<string, PackageInfo>
  workspace: Workspace
}> => {
  logger.starting('Checking dependencies', adapter.name)

  const workspace = readWorkspace(adapter, cwd)
  if (workspace.isWorkspace) {
    logger.debug(
      `Manifests: ${workspace.manifests.map((manifest) => manifest.path).join(', ')}`,
    )
  }
  const own = adapter.ownDiscovery?.(cwd)
  const discovery = own
    ? await own(runFor(adapter, cwd, 'discover'), workspace)
    : await discoverFromRegistry({
        cwd,
        manager: adapter.name,
        workspace,
        registry,
      })
  const outdated =
    discovery.kind === 'single'
      ? discovery.outdated
      : foldWorkspaceEntries(discovery.entries)

  if (Object.keys(outdated).length === 0) {
    logger.allUpToDate()
    return { outdated: {}, workspace }
  }

  return { outdated, workspace }
}

/** The outdated packages, without a report: dry-run and interactive plan their own. */
export const findOutdated = async (
  project: Project,
): Promise<Record<string, PackageInfo>> => (await discover(project)).outdated

/**
 * The outdated packages. The human report plans them first, so each one
 * shows what `update` would do with it and why; `--json` skips the plan.
 */
export const check = async (
  project: Project,
  { report = true }: { report?: boolean } = {},
): Promise<Record<string, PackageInfo>> => {
  const found = await findOutdated(project)
  if (report && Object.keys(found).length > 0) {
    logger.report(await plan(project, found), project.adapter.name, 'plan')
  }
  return found
}

/**
 * Each outdated package's target or hold reason: the config's policy, the
 * overrides the manager enforces, installed peer ranges and the cooldown.
 */
export const plan = (
  { adapter, cwd, config, registry }: Project,
  outdated: Record<string, PackageInfo>,
  targetPackages?: string[],
): Promise<UpdateResult[]> => {
  // Read only when the cooldown holds a target, once.
  let catalogs: Catalogs | undefined
  return filterPackages(outdated, {
    config,
    targetPackages,
    cwd,
    registry,
    overrides: adapter.overrides(cwd),
    declaredRange: ({ name, workspace = '.' }) => {
      catalogs ??= adapter.readWorkspace(cwd).catalogs
      return declaredRange(cwd, workspace, name, catalogs)
    },
  })
}

/**
 * discover → plan → apply → report. `discovered` is a `check` result the
 * caller already has (interactive mode), so discovery does not run again.
 */
export const update = async (
  project: Project,
  {
    targetPackages,
    discovered,
  }: {
    targetPackages?: string[]
    discovered?: Record<string, PackageInfo>
  } = {},
): Promise<UpdateResult[]> => {
  const { adapter, cwd } = project
  const { outdated, workspace } = discovered
    ? { outdated: discovered, workspace: adapter.readWorkspace(cwd) }
    : await discover(project)

  // discover already printed allUpToDate.
  if (Object.keys(outdated).length === 0) return []

  const results = await plan(project, outdated, targetPackages)
  const { names, withinRange, beyondRange, manifests, pinned } =
    splitUpdates(results)
  const moving = names.length + new Set(pinned.map((row) => row.name)).size

  if (moving === 0) {
    logger.report(results, adapter.name, 'plan')
    return results
  }

  logger.updatingHeader(adapter.name, moving)

  // Cooldown fallbacks first: the apply below asks for the rest by name, and
  // leaves the versions they pinned where the lockfile has them.
  if (pinned.length > 0) {
    await applyPinned(runFor(adapter, cwd, 'apply'), cwd, pinned, adapter)
  }
  if (names.length > 0) {
    await adapter.apply(
      runFor(adapter, cwd, 'apply'),
      cwd,
      { names, withinRange, beyondRange, manifests },
      workspace,
    )
  }

  // Report what the manager installed, not what it was asked to install.
  const moved = results.filter((r) => r.updated)
  const applied = checkApplied(
    results,
    adapter.installed
      ? await adapter.installed(runFor(adapter, cwd, 'apply'), cwd, moved)
      : readInstalledVersions(cwd, moved),
    adapter.name,
  )
  logger.report(applied, adapter.name, 'applied')
  return applied
}
