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
    const command = isWorkspace ? "outdated --filter '*'" : 'outdated'

    const commandResult = await this.runCommand(
      this.packageManager,
      command,
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

      const { isWorkspace, hasCatalogs } = await this.checkIfInWorkspace(cwd)
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

      logger.updatingHeader('bun')
      logger.printUpdatingRows(
        results
          .filter((r) => r.updated)
          .map((r) => ({ name: r.name, current: r.current, latest: r.latest })),
      )

      if (packagesToUpdate.length > 0) {
        if (isWorkspace && hasCatalogs) {
          const { catalogPackages, rootPackages } = identifyCatalogPackages(
            cwd,
            outdatedPackages,
          )

          const catalogsToUpdate = catalogPackages.filter((pkg) =>
            packagesToUpdate.includes(pkg),
          )
          const rootToUpdate = rootPackages.filter((pkg) =>
            packagesToUpdate.includes(pkg),
          )

          if (catalogsToUpdate.length > 0) {
            await updateBunCatalogs(cwd, catalogsToUpdate, outdatedPackages)
          }

          if (rootToUpdate.length > 0) {
            await updatePackageJson(cwd, rootToUpdate, outdatedPackages)
          }

          await this.runCommand(this.packageManager, 'install', cwd)
        } else {
          await updatePackageJson(cwd, packagesToUpdate, outdatedPackages)

          const command = isWorkspace
            ? `update ${packagesToUpdate.join(' ')} --filter '*'`
            : `update ${packagesToUpdate.join(' ')}`

          await this.runCommand(this.packageManager, command, cwd)
        }
      }

      logger.cooldownSummary(results)
      return results
    } catch {
      logger.error('An error occurred while checking for outdated packages.')
      return []
    }
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
            latest,
          }
        }
      }
    }

    return result
  }
}

export default BunManager
