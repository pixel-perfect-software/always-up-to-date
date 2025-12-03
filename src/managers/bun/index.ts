import fs from "fs"

import CommandRunner from "@/commandRunner"
import {
  logger,
  updateChecker,
  groupAndSortPackages,
  getSortedGroupNames,
} from "@/utils"

import messages from "@/messages/en.json"
import type { PackageInfo, SupportedPackageManager } from "@/types"
import {
  updatePackageJson,
  updateBunCatalogs,
  identifyCatalogPackages,
} from "@/utils/files"

class BunManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = "bun"

  checkPackageVersions = async (cwd: string): Promise<object> => {
    logger.starting("Checking package versions", "Bun")

    // Check if the current working directory supports Bun workspaces
    // If it does, we can use the `bun outdated --json --filter '*'` command to check for outdated packages recursively
    // If it doesn't, we can use the `bun outdated --json` command to check for outdated packages in the current directory
    const { isWorkspace } = await this.checkIfInWorkspace(cwd)
    const command = isWorkspace ? "outdated --filter '*'" : "outdated"

    const commandResult = await this.runCommand(
      this.packageManager,
      command,
      cwd,
    )
    const result = this.parseBunOutdatedOutput(commandResult || "")

    if (Object.keys(result).length === 0) {
      logger.allUpToDate()
      return {}
    }

    logger.outdatedHeader()

    // Group and sort packages for better readability
    const groupedPackages = groupAndSortPackages(
      result as Record<string, PackageInfo>,
    )
    const sortedGroupNames = getSortedGroupNames(groupedPackages)

    sortedGroupNames.forEach((groupName) => {
      logger.packageGroupHeader(groupName)
      groupedPackages[groupName].forEach(({ name, info }) => {
        logger.outdatedPackageInGroup(name, info.current, info.latest)
      })
    })

    return result
  }

  updatePackages = async (cwd: string): Promise<void> => {
    logger.starting("Updating packages", "Bun")

    try {
      const outdatedPackages = await this.checkPackageVersions(cwd)

      if (Object.keys(outdatedPackages).length === 0) {
        logger.allUpToDate()
        return
      }

      // Get workspace and catalog info
      const { isWorkspace, hasCatalogs } = await this.checkIfInWorkspace(cwd)

      logger.updatingHeader()

      const packagesToUpdate = Object.entries(outdatedPackages)
        .filter(([name, packageInfo]) =>
          updateChecker({ name, ...packageInfo }),
        )
        .map(([packageName]) => packageName)

      if (
        packagesToUpdate.length === 0 &&
        Object.keys(outdatedPackages)?.length > 0
      )
        return logger.info(messages.noPackagesToUpdate)

      if (packagesToUpdate.length > 0) {
        // If workspace with catalogs, separate catalog vs root packages
        if (isWorkspace && hasCatalogs) {
          const { catalogPackages, rootPackages } = identifyCatalogPackages(
            cwd,
            outdatedPackages as Record<string, PackageInfo>,
          )

          // Filter based on packagesToUpdate
          const catalogsToUpdate = catalogPackages.filter((pkg) =>
            packagesToUpdate.includes(pkg),
          )
          const rootToUpdate = rootPackages.filter((pkg) =>
            packagesToUpdate.includes(pkg),
          )

          // Update catalogs in root package.json
          if (catalogsToUpdate.length > 0) {
            await updateBunCatalogs(
              cwd,
              catalogsToUpdate,
              outdatedPackages as Record<string, PackageInfo>,
            )
          }

          // Update root dependencies (non-catalog packages)
          if (rootToUpdate.length > 0) {
            updatePackageJson(
              cwd,
              rootToUpdate,
              outdatedPackages as Record<string, PackageInfo>,
            )
          }

          // Run bun install to apply catalog changes across workspace
          // Don't use 'bun update' as it tries to add packages to root
          await this.runCommand(this.packageManager, "install", cwd)
        } else {
          // Non-catalog workspace or single package
          updatePackageJson(
            cwd,
            packagesToUpdate,
            outdatedPackages as Record<string, PackageInfo>,
          )

          const command = isWorkspace
            ? `update ${packagesToUpdate.join(" ")} --filter '*'`
            : `update ${packagesToUpdate.join(" ")}`

          await this.runCommand(this.packageManager, command, cwd)
        }
      }
    } catch {
      logger.error("An error occurred while checking for outdated packages.")
      return
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
      const packageJsonContent = fs.readFileSync(packageJsonPath, "utf8")
      const packageJson = JSON.parse(packageJsonContent)

      // Bun uses the same workspace format as NPM - workspaces can be defined as an array or an object with packages field
      const hasWorkspaces =
        packageJson.workspaces &&
        (Array.isArray(packageJson.workspaces) ||
          (typeof packageJson.workspaces === "object" &&
            packageJson.workspaces.packages))

      // Check for catalogs (Bun's centralized dependency management)
      // Can be "catalog" (singular, default) or "catalogs" (plural, named)
      const hasDefaultCatalog =
        !!packageJson.catalog && typeof packageJson.catalog === "object"
      const hasNamedCatalogs =
        !!packageJson.catalogs && typeof packageJson.catalogs === "object"
      const hasCatalogs = hasDefaultCatalog || hasNamedCatalogs

      const catalogNames: string[] = []
      if (hasDefaultCatalog) {
        catalogNames.push("catalog")
      }
      if (hasNamedCatalogs) {
        catalogNames.push(...Object.keys(packageJson.catalogs))
      }

      if (hasWorkspaces) {
        logger.workspace("Bun")
        if (hasCatalogs) {
          logger.info(`Detected Bun catalogs: ${catalogNames.join(", ")}`)
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
      .split("\n")
      .filter(
        (line) =>
          line.trim() &&
          !line.includes("|---") &&
          !line.includes("Package") &&
          line.includes("|"),
      )

    for (const line of lines) {
      // Split by | and clean up whitespace
      const columns = line
        .split("|")
        .map((col) => col.trim())
        .filter((col) => col)

      if (columns.length >= 4) {
        const packageNameRaw = columns[0]
        const current = columns[1]
        const latest = columns[3]

        // Extract package name (remove dev/prod indicators)
        const packageName = packageNameRaw
          .replace(/\s*\(dev\)|\s*\(prod\)/, "")
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
