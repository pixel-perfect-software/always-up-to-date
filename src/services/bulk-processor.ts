import { logger } from "../utils/logger";
import { PackageManagerInterface } from "../utils/package-manager";
import { WorkspaceInfo } from "../types/workspace";
import { WorkspaceManager } from "../utils/workspace-manager";
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
    logger.info("Starting bulk dependency processing...");

    // Step 1: Collect all unique external dependencies
    const dependencyMap = this.collectUniqueDependencies();
    const totalPackages = dependencyMap.size;

    logger.info(
      `Found ${totalPackages} unique external dependencies across ${this.workspaceInfo.packages.length} workspaces`
    );

    // Step 2: Get bulk outdated information using package manager
    const outdatedInfo = await this.getBulkOutdatedInfo();

    // Step 3: Merge collected dependencies with outdated info
    const bulkInfo = this.mergeDependencyInfo(dependencyMap, outdatedInfo);

    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(1);
    logger.info(
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
        depInfo.currentVersions.add(this.cleanVersionString(version));
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
        stdout = await this.packageManager.checkWorkspaceOutdated();
      } else {
        logger.debug("Using standard outdated check");
        stdout = await this.packageManager.checkOutdated();
      }

      if (!stdout || stdout.trim() === "") {
        logger.debug("No outdated packages found");
        return {};
      }

      return JSON.parse(stdout);
    } catch (error) {
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
    // npm format: { latest: "1.2.3", ... }
    if (outdatedPackage.latest) {
      return outdatedPackage.latest;
    }

    // yarn format: { latest: "1.2.3", ... } or direct version string
    if (typeof outdatedPackage === "string") {
      return outdatedPackage;
    }

    // pnpm format: { latestVersion: "1.2.3", ... }
    if (outdatedPackage.latestVersion) {
      return outdatedPackage.latestVersion;
    }

    // Generic version field
    if (outdatedPackage.version) {
      return outdatedPackage.version;
    }

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
}
