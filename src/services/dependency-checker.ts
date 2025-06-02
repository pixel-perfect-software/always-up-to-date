import { execSync } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import {
  PackageManagerDetector,
  PackageManagerInterface,
} from "../utils/package-manager";
import { logger } from "../utils/logger";
import {
  wrapError,
  DependencyError,
  NetworkError,
  withRetry,
} from "../utils/errors";
import {
  ConfigManager,
  AlwaysUpToDateConfig,
  UpdateStrategy,
} from "../utils/config";
import { MigrationAdvisor } from "./migration-advisor";
import { WorkspaceManager } from "../utils/workspace-manager";
import {
  WorkspaceInfo,
  WorkspacePackage,
  WorkspaceDependencyUpdate,
} from "../types/workspace";
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
   * Check updates for all workspaces in a monorepo
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

    // Collect all external dependencies and their versions across workspaces
    const allDependencies = new Map<string, Set<string>>();
    const packageDependencies = new Map<string, Record<string, string>>();

    for (const workspace of this.workspaceInfo.packages) {
      const deps = { ...workspace.dependencies, ...workspace.devDependencies };
      packageDependencies.set(workspace.name, deps);

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

    // Check each unique external dependency
    for (const [pkg, versions] of allDependencies) {
      if (this.config.shouldIgnorePackage(pkg)) {
        continue;
      }

      const latestVersion = await this.getLatestVersion(pkg);
      if (this.config.shouldIgnoreVersion(pkg, latestVersion)) {
        continue;
      }

      // Find the highest current version across workspaces
      const sortedVersions = Array.from(versions)
        .map((v) => this.cleanVersionString(v))
        .filter((v) => semver.valid(v))
        .sort((a, b) => semver.compare(b, a)); // descending

      if (sortedVersions.length === 0) continue;

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
          continue;
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

        const update: DependencyUpdate = {
          name: pkg,
          currentVersion: highestCurrentVersion,
          newVersion: latestVersion,
          hasBreakingChanges: hasMajorChange,
          migrationInstructions: instructions,
        };

        if (hasMajorChange && !this.config.shouldAllowMajorUpdate()) {
          allBreakingChanges.push(update);
        } else if (hasMajorChange) {
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
   * Gets the latest version of a package
   * @param pkg Package name
   * @returns Latest version string
   */
  private async getLatestVersion(pkg: string): Promise<string> {
    try {
      const config = this.config.getConfig();
      return await withRetry(
        async () => {
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
