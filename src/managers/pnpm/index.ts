import fs from 'fs'

import CommandRunner, { type SuccessCheck } from '@/commandRunner'
import messages from '@/messages/en.json'
import type {
  PackageInfo,
  SupportedPackageManager,
  UpdateResult,
} from '@/types'
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
import { updatePackageJson, updatePNPMWorkspaceYAML } from '@/utils/files'
import { toManifestNames } from '@/utils/manifestNames'
import { readSaveStyle } from '@/utils/saveStyle'

/**
 * `pnpm outdated` exits 1 whenever something is outdated. On real errors it
 * also exits 1, with the error on stderr and no report on stdout.
 */
const isOutdatedReport: SuccessCheck = ({ exitCode, stdout }) => {
  if (exitCode === 0) return true
  if (exitCode !== 1) return false
  try {
    const report = JSON.parse(stdout)
    return typeof report === 'object' && report !== null
  } catch {
    return false
  }
}

class PNPMManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = 'pnpm'

  checkPackageVersions = async (
    cwd: string,
  ): Promise<Record<string, PackageInfo>> => {
    logger.starting('Checking dependencies', 'pnpm')

    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const args = isRunningInWorkspace
      ? ['outdated', '--json', '-r']
      : ['outdated', '--json']

    // pnpm's `wanted` is the lockfile's version, not the highest version the
    // range allows. `outdated --compatible` reports that one as `latest`, so
    // both run, in parallel.
    const [report, compatibleReport] = await Promise.all([
      this.runStep('discover', this.packageManager, args, cwd, {
        isSuccess: isOutdatedReport,
      }),
      this.runStep(
        'discover',
        this.packageManager,
        [...args, '--compatible'],
        cwd,
        { isSuccess: isOutdatedReport },
      ),
    ])
    const parsed: Record<string, PackageInfo> = JSON.parse(report || '{}')
    const compatible: Record<string, PackageInfo> = JSON.parse(
      compatibleReport || '{}',
    )
    for (const [name, info] of Object.entries(parsed)) {
      info.wanted = compatible[name]?.latest ?? info.wanted
    }
    const result = toManifestNames(cwd, parsed)

    if (Object.keys(result).length === 0) {
      logger.allUpToDate()
      return {}
    }

    logger.outdatedHeader()

    const releaseAges = await computeReleaseAges(result, cwd)
    const groupedPackages = groupAndSortPackages(result)
    const sortedGroupNames = getSortedGroupNames(groupedPackages)

    sortedGroupNames.forEach((groupName) => {
      logger.packageGroupHeader(groupName)
      logger.printOutdatedRows(
        groupedPackages[groupName].map(({ name, info }) =>
          toOutdatedRow(name, info, releaseAges[name]),
        ),
      )
    })

    return result
  }

  /**
   * `discovered` is a result from `checkPackageVersions` the caller already
   * has (interactive mode), so `outdated` is not run a second time.
   */
  updatePackages = async (
    cwd: string,
    targetPackages?: string[],
    discovered?: Record<string, PackageInfo>,
  ): Promise<UpdateResult[]> => {
    const outdatedPackages =
      discovered ?? (await this.checkPackageVersions(cwd))

    if (Object.keys(outdatedPackages).length === 0) {
      // checkPackageVersions already printed allUpToDate.
      return []
    }

    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const results = await filterPackages(outdatedPackages, {
      targetPackages,
      cwd,
      packageManager: this.packageManager,
    })
    const { names, withinRange, beyondRange } = splitUpdates(results)

    if (names.length === 0 && Object.keys(outdatedPackages).length > 0) {
      logger.noPackagesToUpdate(messages.noPackagesToUpdate)
      logger.cooldownSummary(results)
      return results
    }

    logger.updatingHeader('pnpm')
    logger.printUpdatingRows(
      results.filter((r) => r.updated).map(toUpdatingRow),
    )

    if (names.length > 0) {
      // pnpm installs the highest version each range allows. Only packages
      // moving past their range need their manifest spec rewritten first.
      const manifestWritten = Object.keys(beyondRange).length > 0
      // A single-package project can have catalogs too, so they are not tied
      // to being a workspace.
      const usesCatalogs = definesCatalogs(cwd)

      if (isRunningInWorkspace || usesCatalogs) {
        if (manifestWritten) {
          // Versions live in pnpm-workspace.yaml catalogs or directly in a
          // package.json. Run both rewrites — each is a no-op for entries it
          // doesn't own, and updatePackageJson skips `catalog:` /
          // `workspace:` refs so it can't clobber catalog references.
          const style = readSaveStyle(cwd, this.packageManager)
          if (usesCatalogs) {
            await updatePNPMWorkspaceYAML(cwd, beyondRange, style)
          }
          await updatePackageJson(cwd, beyondRange, style)

          // `pnpm install` re-reads both manifest and pnpm-workspace.yaml
          // and relinks node_modules + lockfile reliably. `pnpm update -r`
          // can miss catalog mutations.
          await this.runStep('apply', this.packageManager, ['install'], cwd, {
            manifestWritten,
          })
        }

        // `install` leaves in-range packages where the lockfile has them.
        if (withinRange.length > 0) {
          await this.runStep(
            'apply',
            this.packageManager,
            isRunningInWorkspace
              ? ['update', '-r', ...withinRange]
              : ['update', ...withinRange],
            cwd,
            { manifestWritten },
          )
        }
      } else {
        if (manifestWritten) {
          await updatePackageJson(
            cwd,
            beyondRange,
            readSaveStyle(cwd, this.packageManager),
          )
        }

        await this.runStep(
          'apply',
          this.packageManager,
          ['update', ...names],
          cwd,
          { manifestWritten },
        )
      }
    }

    logger.cooldownSummary(results)
    return results
  }

  checkIfInWorkspace = async (cwd: string): Promise<boolean> => {
    let workspaceFile: string
    try {
      workspaceFile = fs.readFileSync(`${cwd}/pnpm-workspace.yaml`, 'utf8')
    } catch {
      return false
    }

    const isWorkspace = listsWorkspacePackages(workspaceFile)
    if (isWorkspace) logger.workspace('pnpm')

    return isWorkspace
  }
}

/** `catalog:` or `catalogs:` in pnpm-workspace.yaml, which hold versions. */
const definesCatalogs = (cwd: string): boolean => {
  try {
    return /^catalogs?:/m.test(
      fs.readFileSync(`${cwd}/pnpm-workspace.yaml`, 'utf8'),
    )
  } catch {
    return false
  }
}

/**
 * pnpm-workspace.yaml also holds settings (`overrides`, `catalog`,
 * `onlyBuiltDependencies`), so single-package projects often have one. The
 * project is a workspace only when the file lists `packages`, as a block list
 * or a flow list.
 */
const listsWorkspacePackages = (yaml: string): boolean => {
  const lines = yaml.split('\n')
  const start = lines.findIndex((line) => /^packages:/.test(line))
  if (start === -1) return false

  const inline = lines[start].replace(/^packages:\s*/, '')
  if (inline && !inline.startsWith('#')) return /^\[\s*[^\s\]]/.test(inline)

  for (const line of lines.slice(start + 1)) {
    if (/^\s*-\s*[^\s#]/.test(line)) return true
    if (/^\S/.test(line) && !line.startsWith('#')) return false
  }
  return false
}

export default PNPMManager
