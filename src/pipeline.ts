import CommandRunner from '@/commandRunner'
import { discoverFromRegistry } from '@/discovery'
import type { ManagerAdapter, RunManager, Workspace } from '@/managers'
import { applyPinned } from '@/managers/pin'
import type { Project } from '@/project'
import { type PipelineStep, StepError } from '@/stepError'
import type { PackageInfo, UpdateResult } from '@/types'
import { filterPackages, logger, splitUpdates } from '@/utils'
import { type Catalogs, declaredDependency } from '@/utils/dependencySpecs'
import { checkApplied, readInstalledVersions } from '@/utils/installed'
import { foldWorkspaceEntries } from '@/utils/workspaceRows'

const runner = new CommandRunner()

/** The adapter's `run` for one step: failures carry the step's name. */
const runFor =
  (adapter: ManagerAdapter, cwd: string, step: PipelineStep): RunManager =>
  (args, options) =>
    runner.runStep(step, adapter.name, args, cwd, options)

/**
 * The project's workspace, with the member a member run (#123) is scoped to.
 * Discovery reads only that manifest.
 */
const workspaceOf = ({ adapter, root, member }: Project): Workspace => ({
  ...adapter.readWorkspace(root),
  member,
})

const announceWorkspace = (adapter: ManagerAdapter, workspace: Workspace) => {
  const catalogs = Object.keys(workspace.catalogs)
  if (workspace.member) {
    logger.memberRun(
      adapter.name,
      workspace.member.path,
      workspace.manifests.length,
    )
  } else if (workspace.isWorkspace && workspace.manifests.length > 1) {
    // A pnpm workspace listing only "." is one package: nothing to announce.
    logger.workspace(adapter.name, workspace.manifests.length, catalogs.length)
  }
  if (catalogs.length > 0) logger.debug(`catalogs: ${catalogs.join(', ')}`)
}

/**
 * detect → discover: the outdated packages keyed by their package.json
 * names. Nothing is listed here; the report groups them by outcome once
 * they are planned. Discovery reads the manifests,
 * node_modules and the registry, with no manager subprocess; yarn berry
 * alone discovers through the manager.
 */
const discover = async (
  project: Project,
): Promise<{
  outdated: Record<string, PackageInfo>
  workspace: Workspace
}> => {
  const { adapter, root, registry } = project
  logger.starting('Checking dependencies', adapter.name)

  const workspace = workspaceOf(project)
  announceWorkspace(adapter, workspace)
  if (workspace.isWorkspace) {
    logger.debug(
      `Manifests: ${workspace.manifests.map((manifest) => manifest.path).join(', ')}`,
    )
  }
  const own = adapter.ownDiscovery?.(root)
  const discovery = own
    ? await own(runFor(adapter, root, 'discover'), workspace)
    : await discoverFromRegistry({
        cwd: root,
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
    logger.report(await plan(project, found), project.adapter.name, 'plan', {
      member: project.member?.path,
    })
  }
  return found
}

/**
 * Each outdated package's target or hold reason: the config's policy, the
 * overrides the manager enforces, installed peer ranges and the cooldown.
 */
export const plan = (
  { adapter, root, config, registry }: Project,
  outdated: Record<string, PackageInfo>,
  targetPackages?: string[],
): Promise<UpdateResult[]> => {
  // Read only when the cooldown checks a target, once.
  let catalogs: Catalogs | undefined
  return filterPackages(outdated, {
    config,
    targetPackages,
    cwd: root,
    registry,
    overrides: adapter.overrides(root),
    declared: ({ name, workspace = '.' }) => {
      catalogs ??= adapter.readWorkspace(root).catalogs
      return declaredDependency(root, workspace, name, catalogs)
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
  const { adapter, root, member } = project
  const { outdated, workspace } = discovered
    ? { outdated: discovered, workspace: workspaceOf(project) }
    : await discover(project)
  const where = { member: member?.path }

  // discover already printed allUpToDate.
  if (Object.keys(outdated).length === 0) return []

  const results = await plan(project, outdated, targetPackages)
  const { names, withinRange, beyondRange, manifests, pinned } =
    splitUpdates(results)
  const moving = names.length + new Set(pinned.map((row) => row.name)).size

  if (moving === 0) {
    logger.report(results, adapter.name, 'plan', where)
    return results
  }

  logger.updatingHeader(adapter.name, moving)

  // Until the member-scoped apply lands (#123).
  if (member) {
    throw new StepError(
      'apply',
      `updating from a workspace member is not wired yet (#123): run autd from ${root}`,
    )
  }

  // Cooldown fallbacks first: the apply below asks for the rest by name, and
  // leaves the versions they pinned where the lockfile has them.
  if (pinned.length > 0) {
    await applyPinned(runFor(adapter, root, 'apply'), root, pinned, adapter)
  }
  if (names.length > 0) {
    await adapter.apply(
      runFor(adapter, root, 'apply'),
      root,
      { names, withinRange, beyondRange, manifests },
      workspace,
    )
  }

  // Report what the manager installed, not what it was asked to install.
  const moved = results.filter((r) => r.updated)
  const applied = checkApplied(
    results,
    adapter.installed
      ? await adapter.installed(runFor(adapter, root, 'apply'), root, moved)
      : readInstalledVersions(root, moved),
    adapter.name,
  )
  logger.report(applied, adapter.name, 'applied', where)
  return applied
}
