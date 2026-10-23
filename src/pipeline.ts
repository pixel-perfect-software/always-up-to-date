import CommandRunner from '@/commandRunner'
import type { ManagerAdapter, RunManager, Workspace } from '@/managers'
import messages from '@/messages/en.json'
import type { PipelineStep } from '@/stepError'
import type { PackageInfo, UpdateResult } from '@/types'
import {
  computeReleaseAges,
  filterPackages,
  getSortedGroupNames,
  groupAndSortPackages,
  logger,
  splitUpdates,
  toOutdatedRow,
  toUpdatingRow,
} from '@/utils'
import { toManifestNames } from '@/utils/manifestNames'

const runner = new CommandRunner()

/** The adapter's `run` for one step: failures carry the step's name. */
const runFor =
  (adapter: ManagerAdapter, cwd: string, step: PipelineStep): RunManager =>
  (args, options) =>
    runner.runStep(step, adapter.name, args, cwd, options)

const readWorkspace = (adapter: ManagerAdapter, cwd: string): Workspace => {
  const workspace = adapter.readWorkspace(cwd)
  if (workspace.isWorkspace) logger.workspace(adapter.name)
  if (workspace.isWorkspace && workspace.catalogs.length > 0) {
    logger.info(`Detected catalogs: ${workspace.catalogs.join(', ')}`)
  }
  return workspace
}

/**
 * detect → discover → report: the outdated packages keyed by their
 * package.json names, printed in groups.
 */
const discover = async (
  adapter: ManagerAdapter,
  cwd: string,
): Promise<{
  outdated: Record<string, PackageInfo>
  workspace: Workspace
}> => {
  logger.starting('Checking dependencies', adapter.name)

  const workspace = readWorkspace(adapter, cwd)
  const outdated = toManifestNames(
    cwd,
    await adapter.discover(runFor(adapter, cwd, 'discover'), cwd, workspace),
  )

  if (Object.keys(outdated).length === 0) {
    logger.allUpToDate()
    return { outdated: {}, workspace }
  }

  logger.outdatedHeader()

  const releaseAges = await computeReleaseAges(outdated, cwd)
  const groupedPackages = groupAndSortPackages(outdated)
  for (const groupName of getSortedGroupNames(groupedPackages)) {
    logger.packageGroupHeader(groupName)
    logger.printOutdatedRows(
      groupedPackages[groupName].map(({ name, info }) =>
        toOutdatedRow(name, info, releaseAges[name]),
      ),
    )
  }

  return { outdated, workspace }
}

/** The outdated packages, printed in groups. */
export const check = async (
  adapter: ManagerAdapter,
  cwd: string,
): Promise<Record<string, PackageInfo>> =>
  (await discover(adapter, cwd)).outdated

/**
 * Each outdated package's target or hold reason: the config's policy, the
 * overrides the manager enforces, installed peer ranges and the cooldown.
 */
export const plan = (
  adapter: ManagerAdapter,
  cwd: string,
  outdated: Record<string, PackageInfo>,
  targetPackages?: string[],
): Promise<UpdateResult[]> =>
  filterPackages(outdated, {
    targetPackages,
    cwd,
    overrides: adapter.overrides(cwd),
  })

/**
 * discover → plan → apply → report. `discovered` is a `check` result the
 * caller already has (interactive mode), so discovery does not run again.
 */
export const update = async (
  adapter: ManagerAdapter,
  cwd: string,
  {
    targetPackages,
    discovered,
  }: {
    targetPackages?: string[]
    discovered?: Record<string, PackageInfo>
  } = {},
): Promise<UpdateResult[]> => {
  const { outdated, workspace } = discovered
    ? { outdated: discovered, workspace: adapter.readWorkspace(cwd) }
    : await discover(adapter, cwd)

  // discover already printed allUpToDate.
  if (Object.keys(outdated).length === 0) return []

  const results = await plan(adapter, cwd, outdated, targetPackages)
  const { names, withinRange, beyondRange } = splitUpdates(results)

  if (names.length === 0) {
    logger.noPackagesToUpdate(messages.noPackagesToUpdate)
    logger.cooldownSummary(results)
    return results
  }

  logger.updatingHeader(adapter.name)
  logger.printUpdatingRows(results.filter((r) => r.updated).map(toUpdatingRow))

  await adapter.apply(
    runFor(adapter, cwd, 'apply'),
    cwd,
    { names, withinRange, beyondRange, discovered: outdated },
    workspace,
  )

  logger.cooldownSummary(results)
  return results
}
