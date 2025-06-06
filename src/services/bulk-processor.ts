import { logger } from "../utils/logger";
import {
  PackageManagerInterface,
  PackageUpdate,
} from "../utils/package-manager";
import { WorkspaceInfo } from "../types/workspace";
import { WorkspaceManager } from "../utils/workspace-manager";
import { CatalogResolver } from "../utils/catalog-resolver";
import semver from "semver";

interface BulkDependencyInfo {
  name: string;
  currentVersions: Set<string>;
  latestVersion?: string;
  workspaces: string[];
  hasBreakingChanges: boolean;
}

export class BulkProcessor {
  private packageManager: PackageManagerInterface;
  private workspaceInfo: WorkspaceInfo;

  constructor(
    packageManager: PackageManagerInterface,
    workspaceInfo: WorkspaceInfo
  ) {
    this.packageManager = packageManager;
    this.workspaceInfo = workspaceInfo;
  }

  /**
   * Process all dependencies in bulk using native package manager commands
   */
  async processBulkDependencies(): Promise<Map<string, BulkDependencyInfo>> {
    const startTime = Date.now();
    logger.debug("Starting bulk dependency processing...");

    // Step 1: Collect all unique external dependencies
    const dependencyMap = this.collectUniqueDependencies();
    const totalPackages = dependencyMap.size;

    logger.progress(
      `Found ${totalPackages} unique external dependencies across ${this.workspaceInfo.packages.length} workspaces`
    );

    // Step 2: Get bulk outdated information using package manager
    const outdatedInfo = await this.getBulkOutdatedInfo();

    // Step 3: Merge collected dependencies with outdated info
    const bulkInfo = this.mergeDependencyInfo(dependencyMap, outdatedInfo);

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(1);
    logger.debug(
      `Bulk processing completed in ${duration}s for ${totalPackages} packages`
    );

    return bulkInfo;
  }

  /**
   * Collect all unique external dependencies across workspaces
   */
  private collectUniqueDependencies(): Map<string, BulkDependencyInfo> {
    const dependencyMap = new Map<string, BulkDependencyInfo>();

    for (const workspace of this.workspaceInfo.packages) {
      const allDeps = {
        ...workspace.dependencies,
        ...workspace.devDependencies,
      };

      for (const [depName, version] of Object.entries(allDeps)) {
        // Skip internal workspace dependencies
        if (
          WorkspaceManager.isInternalDependency(
            depName,
            this.workspaceInfo.packages
          )
        ) {
          continue;
        }

        if (!dependencyMap.has(depName)) {
          dependencyMap.set(depName, {
            name: depName,
            currentVersions: new Set(),
            workspaces: [],
            hasBreakingChanges: false,
          });
        }

        const depInfo = dependencyMap.get(depName)!;

        // Resolve catalog references to actual versions
        let resolvedVersion = version;
        if (version.startsWith("catalog:")) {
          const catalogVersion = this.workspaceInfo.catalog?.[depName];
          if (catalogVersion) {
            resolvedVersion = catalogVersion;
          } else {
            logger.warn(
              `Catalog reference for ${depName} found but no catalog entry exists`
            );
            continue;
          }
        }

        depInfo.currentVersions.add(this.cleanVersionString(resolvedVersion));
        depInfo.workspaces.push(workspace.name);
      }
    }

    return dependencyMap;
  }

  /**
   * Get bulk outdated information using package manager's native command
   */
  private async getBulkOutdatedInfo(): Promise<Record<string, any>> {
    try {
      let stdout: string;

      // Use workspace-aware command if available
      if (
        this.workspaceInfo.isMonorepo &&
        this.packageManager.checkWorkspaceOutdated
      ) {
        logger.debug("Using workspace-aware outdated check");
        stdout = await this.packageManager.checkWorkspaceOutdated(
          this.workspaceInfo.rootPath
        );
      } else {
        logger.debug("Using standard outdated check");
        stdout = await this.packageManager.checkOutdated(
          this.workspaceInfo.rootPath
        );
      }

      if (!stdout || stdout.trim() === "") {
        logger.debug("No outdated packages found");
        return {};
      }

      return JSON.parse(stdout);
    } catch (error) {
      // Special handling for pnpm which returns exit code 1 when outdated packages are found
      // but still provides valid JSON output in stdout
      if (error instanceof Error) {
        const execError = error as any;
        if (execError.stdout && typeof execError.stdout === "string") {
          try {
            const parsed = JSON.parse(execError.stdout);
            logger.debug("Successfully parsed outdated info from error stdout");
            return parsed;
          } catch (parseError) {
            logger.warn(
              `Failed to parse JSON from error stdout: ${
                (parseError as Error).message
              }`
            );
          }
        }
      }

      logger.warn(`Bulk outdated check failed: ${(error as Error).message}`);
      return {};
    }
  }

  /**
   * Merge collected dependency info with outdated package information
   */
  private mergeDependencyInfo(
    dependencyMap: Map<string, BulkDependencyInfo>,
    outdatedInfo: Record<string, any>
  ): Map<string, BulkDependencyInfo> {
    const mergedMap = new Map<string, BulkDependencyInfo>();

    for (const [depName, depInfo] of dependencyMap) {
      const outdatedPackage = outdatedInfo[depName];
      const updatedInfo: BulkDependencyInfo = { ...depInfo };

      if (outdatedPackage) {
        // Handle different package manager formats
        const latestVersion = this.extractLatestVersion(outdatedPackage);
        if (latestVersion) {
          updatedInfo.latestVersion = latestVersion;

          // Check for breaking changes across all current versions
          updatedInfo.hasBreakingChanges = this.hasAnyBreakingChanges(
            Array.from(depInfo.currentVersions),
            latestVersion
          );
        }
      }

      mergedMap.set(depName, updatedInfo);
    }

    return mergedMap;
  }

  /**
   * Extract latest version from package manager specific outdated format
   */
  private extractLatestVersion(outdatedPackage: any): string | null {
    // pnpm format: { current: "1.2.3", latest: "1.3.0", wanted: "1.2.3", ... }
    if (outdatedPackage.latest) {
      return outdatedPackage.latest;
    }

    // yarn format: { latest: "1.2.3", ... } or direct version string
    if (typeof outdatedPackage === "string") {
      return outdatedPackage;
    }

    // Alternative pnpm format: { latestVersion: "1.2.3", ... }
    if (outdatedPackage.latestVersion) {
      return outdatedPackage.latestVersion;
    }

    // Generic version field
    if (outdatedPackage.version) {
      return outdatedPackage.version;
    }

    // Log what we got for debugging
    logger.debug(
      `Could not extract latest version from: ${JSON.stringify(
        outdatedPackage
      )}`
    );

    return null;
  }

  /**
   * Check if any current version has breaking changes compared to latest
   */
  private hasAnyBreakingChanges(
    currentVersions: string[],
    latestVersion: string
  ): boolean {
    return currentVersions.some((currentVersion) => {
      if (!semver.valid(currentVersion) || !semver.valid(latestVersion)) {
        return false;
      }
      return semver.major(latestVersion) > semver.major(currentVersion);
    });
  }

  /**
   * Clean version string by removing prefix characters
   */
  private cleanVersionString(version: string): string {
    return version.replace(/[\^~>=<]/g, "");
  }

  /**
   * Get the highest version from a set of versions
   */
  static getHighestVersion(versions: Set<string>): string {
    const validVersions = Array.from(versions)
      .filter((v) => semver.valid(v))
      .sort((a, b) => semver.compare(b, a)); // descending order

    return validVersions[0] || Array.from(versions)[0];
  }

  /**
   * Process packages in parallel batches for fallback scenarios
   */
  async processFallbackBatch(
    packages: string[],
    batchSize: number = 50
  ): Promise<Map<string, string>> {
    const versionMap = new Map<string, string>();
    const totalBatches = Math.ceil(packages.length / batchSize);

    logger.info(
      `Processing ${packages.length} packages in ${totalBatches} batches (fallback mode)`
    );

    for (let i = 0; i < packages.length; i += batchSize) {
      const batch = packages.slice(i, i + batchSize);
      const batchNum = Math.floor(i / batchSize) + 1;

      logger.debug(
        `Processing batch ${batchNum}/${totalBatches} (${batch.length} packages)`
      );

      // Process batch with limited concurrency
      const batchPromises = batch.map(async (pkg) => {
        try {
          const version = await this.getSinglePackageVersion(pkg);
          if (version) {
            versionMap.set(pkg, version);
          }
        } catch (error) {
          logger.warn(
            `Failed to get version for ${pkg}: ${(error as Error).message}`
          );
        }
      });

      await Promise.allSettled(batchPromises);

      if (i + batchSize < packages.length) {
        // Small delay between batches to avoid rate limiting
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    return versionMap;
  }

  /**
   * Get version for a single package (fallback method)
   */
  private async getSinglePackageVersion(
    packageName: string
  ): Promise<string | null> {
    try {
      const { execSync } = await import("child_process");
      const version = execSync(`npm show ${packageName} version`, {
        stdio: "pipe",
        timeout: 5000, // 5 second timeout per package
      })
        .toString()
        .trim();
      return version;
    } catch (error) {
      return null;
    }
  }

  /**
   * Perform bulk updates using native package manager commands
   */
  async performBulkUpdates(
    updatesToApply: Array<{
      name: string;
      currentVersion: string;
      newVersion: string;
      hasBreakingChanges: boolean;
    }>
  ): Promise<number> {
    if (updatesToApply.length === 0) {
      logger.info("No updates to apply");
      return 0;
    }

    const startTime = Date.now();
    logger.info(`Starting bulk updates for ${updatesToApply.length} packages`);

    // For pnpm with catalog, separate catalog and direct updates
    if (
      this.workspaceInfo.packageManager === "pnpm" &&
      this.workspaceInfo.catalog
    ) {
      return this.performCatalogAwareUpdates(updatesToApply);
    }

    // Convert to PackageUpdate format
    const packageUpdates: PackageUpdate[] = updatesToApply.map((update) => ({
      name: update.name,
      version: update.newVersion,
    }));

    try {
      if (this.workspaceInfo.isMonorepo) {
        // Use workspace-aware bulk update
        if (this.packageManager.bulkUpdateWorkspaceDependencies) {
          await this.packageManager.bulkUpdateWorkspaceDependencies(
            this.workspaceInfo.rootPath,
            packageUpdates
          );
        } else {
          // Fallback to individual workspace updates
          await this.updateWorkspacesFallback(packageUpdates);
        }
      } else {
        // Single package project
        await this.packageManager.bulkUpdateDependencies(
          this.workspaceInfo.rootPath,
          packageUpdates
        );
      }

      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(1);
      logger.info(
        `Bulk updates completed in ${duration}s for ${updatesToApply.length} packages`
      );

      return updatesToApply.length;
    } catch (error) {
      logger.error(`Bulk update failed: ${(error as Error).message}`);
      // Fallback to individual updates
      logger.info("Falling back to individual package updates...");
      return this.performIndividualUpdates(updatesToApply);
    }
  }

  /**
   * Perform catalog-aware updates for pnpm workspaces
   */
  private async performCatalogAwareUpdates(
    updatesToApply: Array<{
      name: string;
      currentVersion: string;
      newVersion: string;
      hasBreakingChanges: boolean;
    }>
  ): Promise<number> {
    const catalogUpdates: Array<{ name: string; version: string }> = [];
    const directUpdates: PackageUpdate[] = [];

    // Separate updates based on whether they should update catalog or direct dependencies
    for (const update of updatesToApply) {
      const shouldUpdateCatalog = CatalogResolver.shouldUpdateCatalog(
        update.name,
        this.workspaceInfo
      );

      if (shouldUpdateCatalog) {
        catalogUpdates.push({
          name: update.name,
          version: update.newVersion,
        });
      } else {
        // Get workspaces that need direct updates
        const directWorkspaces = CatalogResolver.getDirectUpdateWorkspaces(
          update.name,
          this.workspaceInfo
        );

        if (directWorkspaces.length > 0) {
          directUpdates.push({
            name: update.name,
            version: update.newVersion,
          });
        }
      }
    }

    let successCount = 0;

    // Update catalog entries if any
    if (catalogUpdates.length > 0) {
      logger.info(`Updating ${catalogUpdates.length} catalog entries`);
      const catalogSuccess = await this.updatePnpmCatalog(catalogUpdates);
      if (catalogSuccess) {
        successCount += catalogUpdates.length;
      }
    }

    // Update direct dependencies if any
    if (directUpdates.length > 0) {
      logger.info(`Updating ${directUpdates.length} direct dependencies`);
      try {
        await this.packageManager.bulkUpdateWorkspaceDependencies!(
          this.workspaceInfo.rootPath,
          directUpdates
        );
        successCount += directUpdates.length;
      } catch (error) {
        logger.error(
          `Failed to update direct dependencies: ${(error as Error).message}`
        );
      }
    }

    return successCount;
  }

  /**
   * Update pnpm catalog entries
   */
  private async updatePnpmCatalog(
    updates: Array<{ name: string; version: string }>
  ): Promise<boolean> {
    try {
      const { readFileSync, writeFileSync } = await import("fs");
      const { join } = await import("path");

      const workspacePath = join(
        this.workspaceInfo.rootPath,
        "pnpm-workspace.yaml"
      );
      const content = readFileSync(workspacePath, "utf8");

      let updatedContent = content;

      // Update each catalog entry
      for (const update of updates) {
        const regex = new RegExp(
          `(catalog:\\s*\\n(?:.*\\n)*?\\s*${update.name}:\\s*)([^\\n]+)`,
          "m"
        );

        if (regex.test(updatedContent)) {
          updatedContent = updatedContent.replace(regex, `$1${update.version}`);
          logger.info(
            `Updated catalog entry: ${update.name} -> ${update.version}`
          );
        } else {
          logger.warn(`Catalog entry not found for ${update.name}`);
        }
      }

      // Write back the updated content
      writeFileSync(workspacePath, updatedContent, "utf8");

      // Run pnpm install to apply catalog changes
      const { execSync } = await import("child_process");
      logger.progress("Installing updated catalog dependencies...");

      try {
        const output = execSync("pnpm install", {
          cwd: this.workspaceInfo.rootPath,
          stdio: "pipe",
          encoding: "utf8",
        });

        // Only show important output lines (errors, warnings, completion)
        const lines = output.split("\n");
        const importantLines = lines.filter(
          (line) =>
            line.includes("WARN") ||
            line.includes("ERROR") ||
            line.includes("Done in") ||
            line.includes("deprecated")
        );

        if (importantLines.length > 0) {
          logger.debug("Package manager output:");
          importantLines.forEach((line) => logger.debug(line.trim()));
        }
      } catch (error: any) {
        // Show error output if install fails
        if (error.stdout) {
          logger.debug(`Package manager stdout: ${error.stdout}`);
        }
        if (error.stderr) {
          logger.warn(`Package manager stderr: ${error.stderr}`);
        }
        throw error;
      }

      return true;
    } catch (error) {
      logger.error(
        `Failed to update pnpm catalog: ${(error as Error).message}`
      );
      return false;
    }
  }

  /**
   * Fallback method for updating individual workspaces
   */
  private async updateWorkspacesFallback(
    packageUpdates: PackageUpdate[]
  ): Promise<void> {
    const uniqueWorkspaces = new Set(
      this.workspaceInfo.packages.map((pkg) => pkg.path)
    );

    for (const workspacePath of uniqueWorkspaces) {
      try {
        logger.debug(`Updating workspace at ${workspacePath}`);
        await this.packageManager.bulkUpdateDependencies(
          workspacePath,
          packageUpdates
        );
      } catch (error) {
        logger.warn(
          `Failed to update workspace ${workspacePath}: ${
            (error as Error).message
          }`
        );
        // Continue with other workspaces
      }
    }
  }

  /**
   * Ultimate fallback: update packages one by one
   */
  private async performIndividualUpdates(
    updatesToApply: Array<{
      name: string;
      currentVersion: string;
      newVersion: string;
      hasBreakingChanges: boolean;
    }>
  ): Promise<number> {
    let successCount = 0;
    const batchSize = 5; // Process 5 packages at a time to avoid overwhelming the system

    for (let i = 0; i < updatesToApply.length; i += batchSize) {
      const batch = updatesToApply.slice(i, i + batchSize);

      const batchPromises = batch.map(async (update) => {
        try {
          if (this.workspaceInfo.isMonorepo) {
            // Update in each workspace that contains this dependency
            const workspacesWithDep = this.workspaceInfo.packages.filter(
              (pkg) =>
                pkg.dependencies?.[update.name] ||
                pkg.devDependencies?.[update.name]
            );

            for (const workspace of workspacesWithDep) {
              await this.packageManager.updateDependency(
                workspace.path,
                update.name,
                update.newVersion
              );
            }
          } else {
            await this.packageManager.updateDependency(
              this.workspaceInfo.rootPath,
              update.name,
              update.newVersion
            );
          }

          logger.info(
            `Updated ${update.name} from ${update.currentVersion} to ${update.newVersion}`
          );
          return true;
        } catch (error) {
          logger.error(
            `Failed to update ${update.name}: ${(error as Error).message}`
          );
          return false;
        }
      });

      const results = await Promise.allSettled(batchPromises);
      successCount += results.filter(
        (result) => result.status === "fulfilled" && result.value === true
      ).length;

      // Small delay between batches
      if (i + batchSize < updatesToApply.length) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    logger.info(
      `Individual updates completed: ${successCount}/${updatesToApply.length} successful`
    );
    return successCount;
  }
}
