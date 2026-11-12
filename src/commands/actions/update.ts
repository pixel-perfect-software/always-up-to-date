import {
  findOutdated,
  plan,
  refuseMemberApply,
  update as runUpdate,
} from '@/pipeline'
import { openProject, type Project } from '@/project'
import type { UpdateResult } from '@/types'
import { planDocument, printJson } from '@/utils/jsonDocument'
import logger from '@/utils/logger'
import { workspaceLabel } from '@/utils/workspaceRows'
import reportFailure from '../reportFailure'
import type { UpdateOptions } from '../update'

/** What `autd update` does; `../update.ts` loads it when the command runs. */
export const updateAction = async (
  packages: string[],
  options: UpdateOptions,
): Promise<void> => {
  if (options.json) logger.setJsonOutput(true)

  let project: Project | undefined
  try {
    // Refused before the project is opened: nothing is read or looked up.
    if (options.interactive) refuseInteractive(packages, options)
    project = openProject(process.cwd(), {
      pm: options.pm,
      cache: options.cache,
    })
    const targetPackages = packages.length > 0 ? packages : undefined

    if (options.dryRun) {
      await dryRun(project, targetPackages, options.json)
      return
    }

    if (options.interactive) {
      await interactiveUpdate(project)
      return
    }

    const results = await runUpdate(project, { targetPackages })

    if (options.json) {
      printJson(
        planDocument({
          command: 'update',
          phase: 'applied',
          manager: project.adapter.name,
          member: project.member?.path,
          results,
        }),
      )
    }
  } catch (error) {
    reportFailure(error, { json: options.json, command: 'update' })
  } finally {
    project?.registry.close()
  }
}

/** `-i` picks the packages itself and applies them, and needs a terminal to do it. */
const refuseInteractive = (packages: string[], options: UpdateOptions) => {
  if (packages.length > 0) {
    throw new Error(
      "-i can't be combined with package names: the checklist chooses the packages. Drop -i to update them by name (autd update <packages…>)",
    )
  }
  if (options.dryRun) {
    throw new Error(
      "-i can't be combined with --dry-run: the checklist is for applying updates. Drop -i to preview them (autd update --dry-run)",
    )
  }
  if (!process.stdin.isTTY) {
    throw new Error(
      '-i needs a terminal to show its checklist. Name the packages instead (autd update [packages…]), or preview with autd update --dry-run',
    )
  }
}

const dryRun = async (
  project: Project,
  targetPackages?: string[],
  json?: boolean,
) => {
  const outdatedPackages = await findOutdated(project, targetPackages)

  const results =
    Object.keys(outdatedPackages).length > 0
      ? await plan(project, outdatedPackages, targetPackages)
      : []

  if (json) {
    printJson(
      planDocument({
        command: 'update',
        phase: 'plan',
        manager: project.adapter.name,
        member: project.member?.path,
        results,
      }),
    )
    return
  }
  if (results.length === 0) return

  logger.report(results, project.adapter.name, 'plan', {
    member: project.member?.path,
    next: ['autd update', ...(targetPackages ?? [])].join(' '),
  })
}

/** One choice per package: a package in several manifests moves in all of them. */
const choicesByPackage = (eligible: UpdateResult[]) => {
  const byName = new Map<string, UpdateResult[]>()
  for (const result of eligible) {
    const rows = byName.get(result.name)
    if (rows) rows.push(result)
    else byName.set(result.name, [result])
  }
  const step = (r: UpdateResult) =>
    `${r.current} → ${r.target} (${r.updateType}${r.target === r.wanted ? '' : ', beyond range'})`

  // Selecting a package moves every manifest listed, so each shows its own move.
  return [...byName].map(([name, rows]) => ({
    name: rows.some((r) => r.workspace !== undefined)
      ? `${name}: ${rows.map((r) => `${workspaceLabel(r.workspace ?? '.')} ${step(r)}`).join(', ')}`
      : `${name}: ${step(rows[0])}`,
    value: name,
    checked: true,
  }))
}

const interactiveUpdate = async (project: Project) => {
  refuseMemberApply(project)
  const outdatedPackages = await findOutdated(project)

  if (Object.keys(outdatedPackages).length === 0) return

  const results = await plan(project, outdatedPackages)
  const eligible = results.filter((r) => r.updated)

  // What is held, and why, before the checklist offers the rest.
  logger.report(results, project.adapter.name, 'plan')
  if (eligible.length === 0) return

  const { checkbox } = await import('@inquirer/prompts')

  const selected = await checkbox({
    message: 'Select packages to update:',
    choices: choicesByPackage(eligible),
  })

  if (selected.length === 0) {
    logger.info('No packages selected. Skipping update.')
    return
  }

  await runUpdate(project, {
    targetPackages: selected,
    discovered: outdatedPackages,
  })
}
