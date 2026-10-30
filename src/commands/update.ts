import { type Command, Option } from 'commander'
import {
  findOutdated,
  plan,
  refuseMemberApply,
  update as runUpdate,
} from '@/pipeline'
import { openProject, type Project } from '@/project'
import type { SupportedPackageManager, UpdateResult } from '@/types'
import { logger } from '@/utils'
import { workspaceLabel } from '@/utils/workspaceRows'
import { noCacheOption, pmOption } from './options'
import reportFailure from './reportFailure'

const workingDir = process.cwd()

interface UpdateOptions {
  dryRun?: boolean
  interactive?: boolean
  json?: boolean
  pm?: SupportedPackageManager
  cache?: boolean
}

/**
 * The "update" command.
 * This command updates the project's dependencies within their package.json
 * ranges, and further when the config allows it.
 */
const update = (program: Command) =>
  program
    .command('update [packages...]')
    .description('Update the update-able dependencies of the project.')
    .option(
      '--dry-run',
      'Preview which packages would be updated without making changes',
    )
    .option(
      '-i, --interactive',
      'Interactively select which packages to update',
    )
    .addOption(
      new Option('--json', 'Output results as JSON').conflicts('interactive'),
    )
    .addOption(pmOption())
    .addOption(noCacheOption())
    .action(async (packages: string[], options: UpdateOptions) => {
      if (options.json) logger.setJsonOutput(true)

      let project: Project | undefined
      try {
        project = openProject(workingDir, {
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
          console.log(JSON.stringify(results, null, 2))
        }
      } catch (error) {
        reportFailure(error, options.json)
      } finally {
        project?.registry.close()
      }
    })

const dryRun = async (
  project: Project,
  targetPackages?: string[],
  json?: boolean,
) => {
  const outdatedPackages = await findOutdated(project)

  if (Object.keys(outdatedPackages).length === 0) {
    if (json) console.log(JSON.stringify([], null, 2))
    return
  }

  const results = await plan(project, outdatedPackages, targetPackages)

  if (json) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  logger.report(results, project.adapter.name, 'plan', {
    member: project.member?.path,
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

export default update
