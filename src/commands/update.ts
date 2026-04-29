import type { Command } from 'commander'
import detectPackageManager from '@/detectPackageManager'
import { PackageManager } from '@/managers'
import { filterPackages, logger } from '@/utils'

const workingDir = process.cwd()

interface UpdateOptions {
  dryRun?: boolean
  interactive?: boolean
  json?: boolean
}

/**
 * The "update" command.
 * This command updates the update-able dependencies of the project
 * to their latest versions.
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
    .option('--json', 'Output results as JSON')
    .action(async (packages: string[], options: UpdateOptions) => {
      const packageManagerName = detectPackageManager(workingDir)
      const packageManager = new PackageManager(packageManagerName)
      const targetPackages = packages.length > 0 ? packages : undefined

      if (options.dryRun) {
        await dryRun(packageManager, targetPackages, options.json)
        return
      }

      if (options.interactive) {
        await interactiveUpdate(packageManager)
        return
      }

      const results = await packageManager.manager.updatePackages(
        workingDir,
        targetPackages,
      )

      if (options.json) {
        console.log(JSON.stringify(results, null, 2))
      }
    })

const dryRun = async (
  packageManager: InstanceType<typeof PackageManager>,
  targetPackages?: string[],
  json?: boolean,
) => {
  const outdatedPackages =
    await packageManager.manager.checkPackageVersions(workingDir)

  if (Object.keys(outdatedPackages).length === 0) return

  const results = await filterPackages(outdatedPackages, {
    targetPackages,
    cwd: workingDir,
  })
  const wouldUpdate = results.filter((r) => r.updated)
  const wouldSkip = results.filter((r) => !r.updated)

  if (json) {
    console.log(JSON.stringify(results, null, 2))
    return
  }

  if (wouldUpdate.length > 0) {
    logger.clean(`\nWould update (${wouldUpdate.length})`)
    logger.printUpdatingRows(
      wouldUpdate.map((p) => ({
        name: p.name,
        current: p.current,
        latest: p.latest,
      })),
    )
  }

  if (wouldSkip.length > 0) {
    logger.clean(`\nWould skip (${wouldSkip.length})`)
    logger.printSkippedRows(
      wouldSkip.map((p) => ({
        name: p.name,
        current: p.current,
        latest: p.latest,
        updateType: p.updateType,
        reason: p.reason,
      })),
    )
  }
}

const interactiveUpdate = async (
  packageManager: InstanceType<typeof PackageManager>,
) => {
  const outdatedPackages =
    await packageManager.manager.checkPackageVersions(workingDir)

  if (Object.keys(outdatedPackages).length === 0) return

  const results = await filterPackages(outdatedPackages, { cwd: workingDir })
  const eligible = results.filter((r) => r.updated)

  if (eligible.length === 0) {
    logger.info('No eligible packages to update based on your configuration.')
    return
  }

  const { checkbox } = await import('@inquirer/prompts')

  const selected = await checkbox({
    message: 'Select packages to update:',
    choices: eligible.map((pkg) => ({
      name: `${pkg.name}: ${pkg.current} → ${pkg.latest} (${pkg.updateType})`,
      value: pkg.name,
      checked: true,
    })),
  })

  if (selected.length === 0) {
    logger.info('No packages selected. Skipping update.')
    return
  }

  await packageManager.manager.updatePackages(workingDir, selected)
}

export default update
