import { execSync } from "child_process";

// Performance optimization constants
const VERSION_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface CachedVersion {
  version: string;
  timestamp: number;
}
import {
  PackageManagerDetector,
  PackageManagerInterface,
} from "../utils/package-manager";
import { logger } from "../utils/logger";
import { DependencyError, withRetry } from "../utils/errors";
import { ConfigManager, UpdateStrategy } from "../utils/config";
import { MigrationAdvisor } from "./migration-advisor";
import { WorkspaceManager } from "../utils/workspace-manager";
import { WorkspaceInfo } from "../types/workspace";
import { CacheManager } from "./cache-manager";
import semver from "semver";

interface DependencyUpdate {
  name: string;
  currentVersion: string;
  installedVersion?: string;
  newVersion: string;
  hasBreakingChanges: boolean;
  migrationInstructions?: string;
}

export class DependencyChecker {
  private packageManager: PackageManagerInterface;
  private config: ConfigManager;
  private migrationAdvisor: MigrationAdvisor;
  private workspaceInfo?: WorkspaceInfo;
  private versionCache = new Map<string, CachedVersion>();

  // eslint-disable-next-line no-unused-vars
  constructor(private projectPath: string = process.cwd()) {
    this.packageManager = PackageManagerDetector.detect(this.projectPath);
    this.config = new ConfigManager(this.projectPath);
    this.migrationAdvisor = new MigrationAdvisor();
  }

  /**
   * Initialize workspace information if not already done
   */
  private async initializeWorkspace(): Promise<void> {
    if (!this.workspaceInfo) {
      try {
        logger.debug("Initializing workspace detection...");
        this.workspaceInfo = await WorkspaceManager.detect(this.projectPath);
        if (this.workspaceInfo.isMonorepo) {
          logger.info(
            `Detected monorepo with ${this.workspaceInfo.packages.length} packages`
          );
        } else {
          logger.debug("Single package project detected");
        }
      } catch (error) {
        logger.error(`Failed to detect workspace: ${(error as Error).message}`);
        // Fallback to single package mode
        this.workspaceInfo = {
          isMonorepo: false,
          rootPath: this.projectPath,
          packages: [],
          workspacePatterns: [],
          packageManager: "npm",
        };
      }
    }
  }

  /**
   * Checks for available updates for all dependencies (workspace-aware)
   * @returns Object containing updatable dependencies and breaking changes
   */
  async checkForUpdates(): Promise<{
    updatable: DependencyUpdate[];
    breakingChanges: DependencyUpdate[];
  }> {
    await this.initializeWorkspace();

    if (this.workspaceInfo?.isMonorepo) {
      return this.checkWorkspaceUpdates();
    }

    return this.checkSinglePackageUpdates();
  }

  /**
   * Check updates for all workspaces in a monorepo using bulk processing
   */
  private async checkWorkspaceUpdates(): Promise<{
    updatable: DependencyUpdate[];
    breakingChanges: DependencyUpdate[];
  }> {
    const allUpdatable: DependencyUpdate[] = [];
    const allBreakingChanges: DependencyUpdate[] = [];

    if (!this.workspaceInfo?.packages) {
      return { updatable: [], breakingChanges: [] };
    }

    const startTime = Date.now();
    logger.info(
      `Starting bulk dependency check for monorepo with ${this.workspaceInfo.packages.length} packages`
    );

    try {
      // Use bulk processor for efficient dependency checking
      const bulkProcessor = new (
        await import("./bulk-processor")
      ).BulkProcessor(this.packageManager, this.workspaceInfo);

      const bulkDependencyInfo = await bulkProcessor.processBulkDependencies();

      logger.info(`Processing ${bulkDependencyInfo.size} unique dependencies`);

      // Process bulk results with enhanced parallel processing
      const processPromises = Array.from(bulkDependencyInfo.entries()).map(
        async ([pkg, depInfo]) => {
          try {
            // Skip ignored packages
            if (this.config.shouldIgnorePackage(pkg)) {
              return null;
            }

            // Skip if no latest version found or should be ignored
            if (
              !depInfo.latestVersion ||
              this.config.shouldIgnoreVersion(pkg, depInfo.latestVersion)
            ) {
              return null;
            }

            // Get the highest current version
            const highestCurrentVersion = (
              await import("./bulk-processor")
            ).BulkProcessor.getHighestVersion(depInfo.currentVersions);

            if (!this.canUpdate(highestCurrentVersion, depInfo.latestVersion)) {
              return null;
            }

            // Check if update is allowed based on strategy
            const updateStrategy = this.config.getUpdateStrategyForPackage(pkg);
            if (
              !this.isUpdateAllowed(
                highestCurrentVersion,
                depInfo.latestVersion,
                updateStrategy
              )
            ) {
              return null;
            }

            // Get migration instructions if breaking changes
            const instructions = depInfo.hasBreakingChanges
              ? await this.getMigrationInstructions(
                  pkg,
                  highestCurrentVersion,
                  depInfo.latestVersion
                )
              : undefined;

            const update: DependencyUpdate = {
              name: pkg,
              currentVersion: highestCurrentVersion,
              newVersion: depInfo.latestVersion,
              hasBreakingChanges: depInfo.hasBreakingChanges,
              migrationInstructions: instructions,
            };

            return update;
          } catch (error) {
            logger.warn(
              `Failed to process ${pkg}: ${(error as Error).message}`
            );
            return null;
          }
        }
      );

      // Wait for all processing to complete
      const results = await Promise.allSettled(processPromises);

      // Categorize results
      for (const result of results) {
        if (result.status === "fulfilled" && result.value) {
          const update = result.value;

          if (
            update.hasBreakingChanges &&
            !this.config.shouldAllowMajorUpdate()
          ) {
            allBreakingChanges.push(update);
          } else if (update.hasBreakingChanges) {
            allBreakingChanges.push(update);
          } else {
            allUpdatable.push(update);
          }
        }
      }

      // Report version conflicts
      const conflicts = WorkspaceManager.findVersionConflicts(
        this.workspaceInfo.packages
      );
      if (Object.keys(conflicts).length > 0) {
        logger.warn("Version conflicts detected across workspaces:");
        for (const [pkg, conflictVersions] of Object.entries(conflicts)) {
          logger.warn(`  ${pkg}: ${conflictVersions.join(", ")}`);
        }
      }

      const endTime = Date.now();
      const duration = ((endTime - startTime) / 1000).toFixed(1);
      logger.info(
        `Bulk dependency check complete in ${duration}s: ${allUpdatable.length} updatable, ${allBreakingChanges.length} breaking changes`
      );

      return { updatable: allUpdatable, breakingChanges: allBreakingChanges };
    } catch (error) {
      logger.error(`Bulk dependency check failed: ${(error as Error).message}`);
      // Fallback to original method if bulk processing fails
      logger.info("Falling back to individual package checking...");
      return this.checkWorkspaceUpdatesFallback();
    }
  }

  /**
   * Fallback method for workspace updates if bulk processing fails
   */
  private async checkWorkspaceUpdatesFallback(): Promise<{
    updatable: DependencyUpdate[];
    breakingChanges: DependencyUpdate[];
  }> {
    const allUpdatable: DependencyUpdate[] = [];
    const allBreakingChanges: DependencyUpdate[] = [];

    if (!this.workspaceInfo?.packages) {
      return { updatable: [], breakingChanges: [] };
    }

    // Collect all external dependencies and their versions across workspaces
    const allDependencies = new Map<string, Set<string>>();

    for (const workspace of this.workspaceInfo.packages) {
      const deps = { ...workspace.dependencies, ...workspace.devDependencies };

      for (const [pkg, version] of Object.entries(deps)) {
        if (
          !WorkspaceManager.isInternalDependency(
            pkg,
            this.workspaceInfo.packages
          )
        ) {
          if (!allDependencies.has(pkg)) {
            allDependencies.set(pkg, new Set());
          }
          allDependencies.get(pkg)!.add(version);
        }
      }
    }

    // Filter out ignored packages
    const packagesToCheck = Array.from(allDependencies.entries()).filter(
      ([pkg]) => !this.config.shouldIgnorePackage(pkg)
    );

    logger.info(
      `Fallback: Processing ${packagesToCheck.length} packages with increased concurrency`
    );

    // Process all packages in parallel with high concurrency
    const processPromises = packagesToCheck.map(async ([pkg, versions]) => {
      try {
        const latestVersion = await this.getLatestVersionCached(pkg);
        if (this.config.shouldIgnoreVersion(pkg, latestVersion)) {
          return null;
        }

        const sortedVersions = Array.from(versions)
          .map((v) => this.cleanVersionString(v))
          .filter((v) => semver.valid(v))
          .sort((a, b) => semver.compare(b, a));

        if (sortedVersions.length === 0) return null;

        const highestCurrentVersion = sortedVersions[0];

        if (this.canUpdate(highestCurrentVersion, latestVersion)) {
          const updateStrategy = this.config.getUpdateStrategyForPackage(pkg);
          if (
            !this.isUpdateAllowed(
              highestCurrentVersion,
              latestVersion,
              updateStrategy
            )
          ) {
            return null;
          }

          const hasMajorChange = this.hasBreakingChanges(
            highestCurrentVersion,
            latestVersion
          );
          const instructions = hasMajorChange
            ? await this.getMigrationInstructions(
                pkg,
                highestCurrentVersion,
                latestVersion
              )
            : undefined;

          return {
            name: pkg,
            currentVersion: highestCurrentVersion,
            newVersion: latestVersion,
            hasBreakingChanges: hasMajorChange,
            migrationInstructions: instructions,
          };
        }
        return null;
      } catch (error) {
        logger.warn(`Fallback failed for ${pkg}: ${(error as Error).message}`);
        return null;
      }
    });

    // Process all packages in parallel
    const results = await Promise.allSettled(processPromises);

    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        const update = result.value;
        if (update.hasBreakingChanges) {
          allBreakingChanges.push(update);
        } else {
          allUpdatable.push(update);
        }
      }
    }

    return { updatable: allUpdatable, breakingChanges: allBreakingChanges };
  }

  /**
   * Check updates for a single package (non-monorepo)
   */
  private async checkSinglePackageUpdates(): Promise<{
    updatable: DependencyUpdate[];
    breakingChanges: DependencyUpdate[];
  }> {
    try {
      const dependencies = await this.packageManager.getDependencies(
        this.projectPath
      );
      const updatable: DependencyUpdate[] = [];
      const breakingChanges: DependencyUpdate[] = [];

      for (const [pkg, currentVersion] of Object.entries(dependencies)) {
        // Skip ignored packages
        if (this.config.shouldIgnorePackage(pkg)) {
          logger.debug(`Skipping ignored package: ${pkg}`);
          continue;
        }

        const latestVersion = await this.getLatestVersion(pkg);

        // Skip if this version should be ignored for this package
        if (this.config.shouldIgnoreVersion(pkg, latestVersion)) {
          logger.debug(
            `Skipping ignored version ${latestVersion} for package: ${pkg}`
          );
          continue;
        }

        const installedVersion = await this.packageManager.getInstalledVersion(
          this.projectPath,
          pkg
        );

        // Clean version strings (remove carets, tildes, etc.)
        const cleanCurrentVersion = this.cleanVersionString(currentVersion);
        const cleanInstalledVersion = installedVersion
          ? this.cleanVersionString(installedVersion)
          : null;

        // Check if either the package.json version or installed version needs updating
        const needsUpdate =
          this.canUpdate(cleanCurrentVersion, latestVersion) ||
          (cleanInstalledVersion &&
            this.canUpdate(cleanInstalledVersion, latestVersion));

        if (needsUpdate) {
          // Check if this update is allowed based on package-specific rules
          const updateStrategy = this.config.getUpdateStrategyForPackage(pkg);
          if (
            !this.isUpdateAllowed(
              cleanCurrentVersion,
              latestVersion,
              updateStrategy
            )
          ) {
            logger.debug(
              `Update not allowed for ${pkg} based on update strategy: ${updateStrategy}`
            );
            continue;
          }

          const hasMajorChange =
            this.hasBreakingChanges(cleanCurrentVersion, latestVersion) ||
            (cleanInstalledVersion &&
              this.hasBreakingChanges(cleanInstalledVersion, latestVersion));

          // Skip major updates if not allowed by config
          if (hasMajorChange && !this.config.shouldAllowMajorUpdate()) {
            const instructions = await this.getMigrationInstructions(
              pkg,
              cleanCurrentVersion,
              latestVersion
            );
            breakingChanges.push({
              name: pkg,
              currentVersion: cleanCurrentVersion,
              installedVersion: cleanInstalledVersion || undefined,
              newVersion: latestVersion,
              hasBreakingChanges: true,
              migrationInstructions: instructions,
            });
          } else if (hasMajorChange) {
            const instructions = await this.getMigrationInstructions(
              pkg,
              cleanCurrentVersion,
              latestVersion
            );
            breakingChanges.push({
              name: pkg,
              currentVersion: cleanCurrentVersion,
              installedVersion: cleanInstalledVersion || undefined,
              newVersion: latestVersion,
              hasBreakingChanges: true,
              migrationInstructions: instructions,
            });
          } else {
            updatable.push({
              name: pkg,
              currentVersion: cleanCurrentVersion,
              installedVersion: cleanInstalledVersion || undefined,
              newVersion: latestVersion,
              hasBreakingChanges: false,
            });
          }
        }
      }

      return { updatable, breakingChanges };
    } catch (error) {
      logger.error(`Error checking for updates: ${(error as Error).message}`);
      return { updatable: [], breakingChanges: [] };
    }
  }

  /**
   * Updates dependencies that don't have breaking changes
   * @returns Array of updated dependencies
   */
  async updateDependencies(): Promise<DependencyUpdate[]> {
    try {
      const { updatable } = await this.checkForUpdates();

      for (const dep of updatable) {
        logger.info(
          `Updating ${dep.name} from ${dep.currentVersion} to ${dep.newVersion}`
        );
        await this.packageManager.updateDependency(
          this.projectPath,
          dep.name,
          dep.newVersion
        );
      }

      return updatable;
    } catch (error) {
      logger.error(`Error updating dependencies: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Cleans a version string by removing prefix characters like ^ or ~
   * @param version The version string to clean
   * @returns The cleaned version string
   */
  private cleanVersionString(version: string): string {
    return version.replace(/[\^~>=<]/g, "");
  }

  /**
   * Gets the latest version of a package using bulk operations when possible
   * @param pkg Package name
   * @returns Latest version string
   */
  private async getLatestVersion(pkg: string): Promise<string> {
    try {
      const config = this.config.getConfig();
      return await withRetry(
        async () => {
          // Try to use package manager's bulk outdated command first
          const bulkResult = await this.getBulkVersionInfo([pkg]);
          if (bulkResult.has(pkg)) {
            return bulkResult.get(pkg)!;
          }

          // Fallback to individual npm show command
          const command = `npm show ${pkg} version`;
          return execSync(command, { stdio: "pipe" }).toString().trim();
        },
        config.retryAttempts,
        config.retryDelay
      );
    } catch (error) {
      logger.error(
        new DependencyError(
          `Error getting latest version for ${pkg}`,
          pkg,
          error as Error
        )
      );
      return "0.0.0"; // Return a fallback version that won't trigger updates
    }
  }

  /**
   * Gets bulk version information using package manager specific commands
   * @param packages Array of package names
   * @returns Map of package names to their latest versions
   */
  private async getBulkVersionInfo(
    packages: string[]
  ): Promise<Map<string, string>> {
    const versionMap = new Map<string, string>();

    if (packages.length === 0) {
      return versionMap;
    }

    try {
      // Use workspace-aware command for monorepos if available
      let stdout: string;
      if (
        this.workspaceInfo?.isMonorepo &&
        this.packageManager.checkWorkspaceOutdated
      ) {
        stdout = await this.packageManager.checkWorkspaceOutdated();
      } else {
        stdout = await this.packageManager.checkOutdated();
      }

      const outdatedData = JSON.parse(stdout || "{}");

      // Parse npm outdated format
      for (const [pkg, info] of Object.entries(
        outdatedData as Record<string, any>
      )) {
        if (packages.includes(pkg) && info?.latest) {
          versionMap.set(pkg, info.latest);
        }
      }
    } catch (error) {
      logger.debug(`Bulk version check failed: ${(error as Error).message}`);
    }

    return versionMap;
  }

  /**
   * Gets the latest version of a package with persistent caching
   * @param pkg Package name
   * @returns Latest version string
   */
  private async getLatestVersionCached(pkg: string): Promise<string> {
    const cacheManager = new CacheManager(this.projectPath);
    const packageManagerType = this.workspaceInfo?.packageManager || "npm";

    // Check persistent cache first
    const cachedVersion = cacheManager.getCachedVersion(
      pkg,
      packageManagerType
    );
    if (cachedVersion) {
      return cachedVersion;
    }

    // Check in-memory cache as fallback
    const now = Date.now();
    const inMemoryCached = this.versionCache.get(pkg);
    if (inMemoryCached && now - inMemoryCached.timestamp < VERSION_CACHE_TTL) {
      // Update persistent cache
      cacheManager.setCachedVersion(
        pkg,
        inMemoryCached.version,
        packageManagerType
      );
      return inMemoryCached.version;
    }

    // Fetch new version
    const version = await this.getLatestVersion(pkg);

    // Cache in both locations
    this.versionCache.set(pkg, { version, timestamp: now });
    cacheManager.setCachedVersion(pkg, version, packageManagerType);

    return version;
  }

  /**
   * Determines if a package can be updated
   * @param current Current version
   * @param latest Latest version
   * @returns True if the package can be updated
   */
  private canUpdate(current: string, latest: string): boolean {
    return (
      semver.valid(current) !== null &&
      semver.valid(latest) !== null &&
      semver.lt(current, latest)
    );
  }

  /**
   * Checks if an update contains breaking changes
   * @param current Current version
   * @param latest Latest version
   * @returns True if the update contains breaking changes
   */
  private hasBreakingChanges(current: string, latest: string): boolean {
    if (semver.valid(current) === null || semver.valid(latest) === null) {
      return false;
    }

    const currentMajor = semver.major(current);
    const latestMajor = semver.major(latest);

    return latestMajor > currentMajor;
  }

  /**
   * Gets migration instructions for breaking changes using the MigrationAdvisor
   * @param pkg Package name
   * @param currentVersion Current version
   * @param latestVersion Latest version
   * @returns Migration instructions as a string
   */
  private async getMigrationInstructions(
    pkg: string,
    currentVersion: string,
    latestVersion: string
  ): Promise<string> {
    try {
      return await this.migrationAdvisor.getMigrationInstructions(
        pkg,
        currentVersion,
        latestVersion
      );
    } catch (error) {
      logger.error(
        `Error getting migration instructions for ${pkg}: ${
          (error as Error).message
        }`
      );
      return `Unable to fetch migration instructions for ${pkg}. Please check the package documentation manually.`;
    }
  }

  /**
   * Check if an update is allowed based on the update strategy
   */
  private isUpdateAllowed(
    currentVersion: string,
    latestVersion: string,
    updateStrategy: UpdateStrategy
  ): boolean {
    if (updateStrategy === "none") {
      return false;
    }

    const currentMajor = parseInt(currentVersion.split(".")[0]);
    const latestMajor = parseInt(latestVersion.split(".")[0]);
    const currentMinor = parseInt(currentVersion.split(".")[1] || "0");
    const latestMinor = parseInt(latestVersion.split(".")[1] || "0");

    switch (updateStrategy) {
      case "patch":
        return currentMajor === latestMajor && currentMinor === latestMinor;
      case "minor":
        return currentMajor === latestMajor;
      case "major":
        return true;
      default:
        return true;
    }
  }
}

// Helper functions for external use
export async function checkForUpdates(projectPath?: string) {
  const checker = new DependencyChecker(projectPath);
  return checker.checkForUpdates();
}

export async function updateDependencies(projectPath?: string) {
  const checker = new DependencyChecker(projectPath);
  return checker.updateDependencies();
}

export async function checkDependencies(
  dependencies: Record<string, string>
): Promise<DependencyUpdate[]> {
  const updates: DependencyUpdate[] = [];

  for (const [name, currentVersion] of Object.entries(dependencies)) {
    try {
      const command = `npm show ${name} version`;
      const latestVersion = execSync(command, { stdio: "pipe" })
        .toString()
        .trim();

      if (latestVersion && semver.gt(latestVersion, currentVersion)) {
        const hasBreakingChanges =
          semver.major(latestVersion) !== semver.major(currentVersion);

        updates.push({
          name,
          currentVersion,
          newVersion: latestVersion,
          hasBreakingChanges,
        });
      }
    } catch (error) {
      logger.warn(`Failed to check ${name}: ${error}`);
    }
  }

  return updates;
}
