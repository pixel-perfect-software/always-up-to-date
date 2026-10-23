import { type Command, Option } from 'commander'
import { check, plan, update as runUpdate } from '@/pipeline'
import { openProject, type Project } from '@/project'
import type { SupportedPackageManager, UpdateResult } from '@/types'
import { logger, toSkippedRow, toUpdatingRow } from '@/utils'
import { workspaceLabel } from '@/utils/workspaceRows'
import { pmOption } from './options'
import reportFailure from './reportFailure'

const workingDir = process.cwd()

interface UpdateOptions {
  dryRun?: boolean
  interactive?: boolean
  json?: boolean
  pm?: SupportedPackageManager
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
    .action(async (packages: string[], options: UpdateOptions) => {
      if (options.json) logger.setJsonOutput(true)

      try {
        const project = openProject(workingDir, { pm: options.pm })
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
      }
    })

const dryRun = async (
  project: Project,
  targetPackages?: string[],
  json?: boolean,
) => {
  const outdatedPackages = await check(project)

  if (Object.keys(outdatedPackages).length === 0) {
    if (json) console.log(JSON.stringify([], null, 2))
    return
  }

  const results = await plan(project, outdatedPackages, targetPackages)
  const wouldUpdate = results.filter((r) => r.updated)
  const wouldSkip = results.filter((r) => !r.updated)

  if (json) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  if (wouldUpdate.length > 0) {
    logger.clean(`\nWould update (${wouldUpdate.length})`)
    logger.printUpdatingRows(wouldUpdate.map(toUpdatingRow))
  }

  if (wouldSkip.length > 0) {
    logger.clean(`\nWould skip (${wouldSkip.length})`)
    logger.printSkippedRows(wouldSkip.map(toSkippedRow))
  }
}

/** One choice per package: a package in several manifests moves in all of them. */
const choicesByPackage = (eligible: UpdateResult[]) => {
  const byName = new Map<string, UpdateResult[]>()
  for (const result of eligible) {
    const rows = byName.get(result.name)
    if (rows) rows.push(result)
    else byName.set(result.name, [result])
  }
  return [...byName].map(([name, rows]) => {
    const [pkg] = rows
    const where = rows.some((r) => r.workspace !== undefined)
      ? ` in ${rows.map((r) => workspaceLabel(r.workspace ?? '.')).join(', ')}`
      : ''
    return {
      name: `${name}: ${pkg.current} → ${pkg.target} (${pkg.updateType}${pkg.target === pkg.wanted ? '' : ', beyond range'})${where}`,
      value: name,
      checked: true,
    }
  })
}

const interactiveUpdate = async (project: Project) => {
  const outdatedPackages = await check(project)

  if (Object.keys(outdatedPackages).length === 0) return

  const results = await plan(project, outdatedPackages)
  const eligible = results.filter((r) => r.updated)

  if (eligible.length === 0) {
    logger.info('No eligible packages to update based on your configuration.')
    return
  }

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
