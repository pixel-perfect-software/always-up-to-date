import fs from 'fs'

import CommandRunner from '@/commandRunner'
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
} from '@/utils'
import { updatePackageJson, updatePNPMWorkspaceYAML } from '@/utils/files'

class PNPMManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = 'pnpm'

  checkPackageVersions = async (
    cwd: string,
  ): Promise<Record<string, PackageInfo>> => {
    logger.starting('Checking dependencies', 'pnpm')

    const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
    const command = isRunningInWorkspace
      ? 'outdated --json -r'
      : 'outdated --json'

    const commandResult = await this.runCommand(
      this.packageManager,
      command,
      cwd,
    )
    const result: Record<string, PackageInfo> = JSON.parse(
      commandResult || '{}',
    )

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
        groupedPackages[groupName].map(({ name, info }) => ({
          name,
          current: info.current,
          latest: info.latest,
          releaseAge: releaseAges[name],
        })),
      )
    })

    return result
  }

  updatePackages = async (
    cwd: string,
    targetPackages?: string[],
  ): Promise<UpdateResult[]> => {
    try {
      const outdatedPackages = await this.checkPackageVersions(cwd)

      if (Object.keys(outdatedPackages).length === 0) {
        // checkPackageVersions already printed allUpToDate.
        return []
      }

      const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
      const results = await filterPackages(outdatedPackages, {
        targetPackages,
        cwd,
      })
      const packagesToUpdate = results
        .filter((r) => r.updated)
        .map((r) => r.name)

      if (
        packagesToUpdate.length === 0 &&
        Object.keys(outdatedPackages).length > 0
      ) {
        logger.noPackagesToUpdate(messages.noPackagesToUpdate)
        logger.cooldownSummary(results)
        return results
      }

      logger.updatingHeader('pnpm')
      logger.printUpdatingRows(
        results
          .filter((r) => r.updated)
          .map((r) => ({ name: r.name, current: r.current, latest: r.latest })),
      )

      if (packagesToUpdate.length > 0) {
        if (isRunningInWorkspace) {
          // Workspaces can hold versions in either pnpm-workspace.yaml
          // catalogs or directly in a workspace package's package.json.
          // Run both rewrites — each is a no-op for entries it doesn't
          // own, and updatePackageJson skips `catalog:` / `workspace:`
          // refs so it can't clobber catalog references.
          await updatePNPMWorkspaceYAML(cwd, packagesToUpdate, outdatedPackages)
          await updatePackageJson(cwd, packagesToUpdate, outdatedPackages)
        } else {
          await updatePackageJson(cwd, packagesToUpdate, outdatedPackages)
        }

        // For workspaces (especially with catalogs), `pnpm install`
        // re-reads both manifest and pnpm-workspace.yaml and relinks
        // node_modules + lockfile reliably. `pnpm update -r` can miss
        // catalog mutations, so prefer install in workspace mode.
        const command = isRunningInWorkspace
          ? 'install'
          : `update ${packagesToUpdate.join(' ')}`

        await this.runCommand(this.packageManager, command, cwd)
      }

      logger.cooldownSummary(results)
      return results
    } catch {
      logger.error('An error occurred while checking for outdated packages.')
      return []
    }
  }

  checkIfInWorkspace = async (cwd: string): Promise<boolean> => {
    try {
      const workspaceFile = fs.readFileSync(
        `${cwd}/pnpm-workspace.yaml`,
        'utf8',
      )

      logger.workspace('pnpm')

      return !!workspaceFile
    } catch {
      return false
    }
  }
}

export default PNPMManager
