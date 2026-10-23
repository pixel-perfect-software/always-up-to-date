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
  splitUpdates,
  toOutdatedRow,
  toUpdatingRow,
} from '@/utils'
import {
  identifyCatalogPackages,
  updateBunCatalogs,
  updatePackageJson,
} from '@/utils/files'

class BunManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = 'bun'

  checkPackageVersions = async (
    cwd: string,
  ): Promise<Record<string, PackageInfo>> => {
    logger.starting('Checking dependencies', 'bun')

    const { isWorkspace } = await this.checkIfInWorkspace(cwd)
    const args = isWorkspace ? ['outdated', '--filter', '*'] : ['outdated']

    const commandResult = await this.runStep(
      'discover',
      this.packageManager,
      args,
      cwd,
    )
    const result = this.parseBunOutdatedOutput(commandResult || '')

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

    const { isWorkspace, hasCatalogs } = await this.checkIfInWorkspace(cwd)
    const results = await filterPackages(outdatedPackages, {
      targetPackages,
      cwd,
    })
    const { names, withinRange, beyondRange } = splitUpdates(results)

    if (names.length === 0 && Object.keys(outdatedPackages).length > 0) {
      logger.noPackagesToUpdate(messages.noPackagesToUpdate)
      logger.cooldownSummary(results)
      return results
    }

    logger.updatingHeader('bun')
    logger.printUpdatingRows(
      results.filter((r) => r.updated).map(toUpdatingRow),
    )

    if (names.length > 0) {
      // bun installs the highest version each range allows. Only packages
      // moving past their range need their manifest spec rewritten first.
      const manifestWritten = Object.keys(beyondRange).length > 0

      if (isWorkspace && hasCatalogs) {
        const { catalogPackages } = identifyCatalogPackages(
          cwd,
          outdatedPackages,
        )
        const catalogVersions: Record<string, string> = {}
        const rootVersions: Record<string, string> = {}
        for (const [name, version] of Object.entries(beyondRange)) {
          if (catalogPackages.includes(name)) catalogVersions[name] = version
          else rootVersions[name] = version
        }

        if (Object.keys(catalogVersions).length > 0) {
          await updateBunCatalogs(cwd, catalogVersions)
        }

        if (Object.keys(rootVersions).length > 0) {
          await updatePackageJson(cwd, rootVersions)
        }

        if (manifestWritten) {
          await this.runStep('apply', this.packageManager, ['install'], cwd, {
            manifestWritten,
          })
        }

        // `install` leaves in-range packages where the lockfile has them.
        if (withinRange.length > 0) {
          await this.runStep(
            'apply',
            this.packageManager,
            ['update', ...withinRange, '--filter', '*'],
            cwd,
            { manifestWritten },
          )
        }
      } else {
        if (manifestWritten) await updatePackageJson(cwd, beyondRange)

        const args = isWorkspace
          ? ['update', ...names, '--filter', '*']
          : ['update', ...names]

        await this.runStep('apply', this.packageManager, args, cwd, {
          manifestWritten,
        })
      }
    }

    logger.cooldownSummary(results)
    return results
  }

  checkIfInWorkspace = async (
    cwd: string,
  ): Promise<{
    isWorkspace: boolean
    hasCatalogs: boolean
    catalogNames: string[]
  }> => {
    try {
      const packageJsonPath = `${cwd}/package.json`
      const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf8')
      const packageJson = JSON.parse(packageJsonContent)

      // Bun uses the same workspace format as NPM - workspaces can be defined as an array or an object with packages field
      const hasWorkspaces =
        packageJson.workspaces &&
        (Array.isArray(packageJson.workspaces) ||
          (typeof packageJson.workspaces === 'object' &&
            packageJson.workspaces.packages))

      // Check for catalogs (Bun's centralized dependency management)
      // Can be "catalog" (singular, default) or "catalogs" (plural, named)
      const hasDefaultCatalog =
        !!packageJson.catalog && typeof packageJson.catalog === 'object'
      const hasNamedCatalogs =
        !!packageJson.catalogs && typeof packageJson.catalogs === 'object'
      const hasCatalogs = hasDefaultCatalog || hasNamedCatalogs

      const catalogNames: string[] = []
      if (hasDefaultCatalog) {
        catalogNames.push('catalog')
      }
      if (hasNamedCatalogs) {
        catalogNames.push(...Object.keys(packageJson.catalogs))
      }

      if (hasWorkspaces) {
        logger.workspace('bun')
        if (hasCatalogs) {
          logger.info(`Detected Bun catalogs: ${catalogNames.join(', ')}`)
        }
      }

      return {
        isWorkspace: !!hasWorkspaces,
        hasCatalogs,
        catalogNames,
      }
    } catch {
      return { isWorkspace: false, hasCatalogs: false, catalogNames: [] }
    }
  }

  private parseBunOutdatedOutput = (
    output: string,
  ): Record<string, PackageInfo> => {
    const result: Record<string, PackageInfo> = {}

    // Split output into lines and filter out header/separator lines
    const lines = output
      .split('\n')
      .filter(
        (line) =>
          line.trim() &&
          !line.includes('|---') &&
          !line.includes('Package') &&
          line.includes('|'),
      )

    for (const line of lines) {
      // Split by | and clean up whitespace
      const columns = line
        .split('|')
        .map((col) => col.trim())
        .filter((col) => col)

      if (columns.length >= 4) {
        const packageNameRaw = columns[0]
        const current = columns[1]
        // bun's "Update" column: the highest version the range allows.
        const wanted = columns[2]
        const latest = columns[3]

        // Extract package name (remove dev/prod indicators)
        const packageName = packageNameRaw
          .replace(/\s*\(dev\)|\s*\(prod\)/, '')
          .trim()

        // Only include packages that have updates available (current !== latest)
        if (current !== latest) {
          result[packageName] = {
            name: packageName,
            current,
            wanted,
            latest,
          }
        }
      }
    }

    return result
  }
}

export default BunManager
