import {
  WorkspaceInfo,
  VersionInfo,
  ResolvedDependency,
} from "../types/workspace";
import { logger } from "./logger";
import semver from "semver";

export class CatalogResolver {
  /**
   * Resolves a dependency version considering catalog references and direct versions
   * with automatic priority resolution
   */
  static resolveDependencyVersion(
    packageName: string,
    workspaceInfo: WorkspaceInfo
  ): ResolvedDependency | null {
    const versions = new Map<string, VersionInfo>();

    // Collect all versions across workspaces
    for (const workspace of workspaceInfo.packages) {
      const version =
        workspace.dependencies[packageName] ||
        workspace.devDependencies[packageName];

      if (version) {
        if (version.startsWith("catalog:")) {
          // Resolve catalog reference to actual version
          const catalogVersion = workspaceInfo.catalog?.[packageName];
          if (catalogVersion) {
            versions.set(workspace.name, {
              specified: version,
              resolved: catalogVersion,
              source: "catalog",
              workspace: workspace.name,
            });
          } else {
            logger.warn(
              `Catalog reference for ${packageName} found but no catalog entry exists`
            );
          }
        } else {
          // Direct version
          versions.set(workspace.name, {
            specified: version,
            resolved: version,
            source: "direct",
            workspace: workspace.name,
          });
        }
      }
    }

    if (versions.size === 0) {
      return null;
    }

    // Auto-select highest priority version
    return this.selectHighestPriorityVersion(packageName, versions);
  }

  /**
   * Selects the highest priority version based on resolution rules
   * Priority: specific version > version range > catalog reference
   */
  private static selectHighestPriorityVersion(
    packageName: string,
    versions: Map<string, VersionInfo>
  ): ResolvedDependency {
    let highestPriority: VersionInfo | null = null;

    for (const [workspace, info] of versions) {
      if (!highestPriority || this.hasHigherPriority(info, highestPriority)) {
        highestPriority = info;
      }
    }

    return {
      name: packageName,
      version: highestPriority!.resolved,
      source: highestPriority!.source,
      originalSpecifier: highestPriority!.specified,
    };
  }

  /**
   * Determines if versionA has higher priority than versionB
   */
  private static hasHigherPriority(
    versionA: VersionInfo,
    versionB: VersionInfo
  ): boolean {
    // Direct versions have higher priority than catalog
    if (versionA.source === "direct" && versionB.source === "catalog") {
      return true;
    }
    if (versionA.source === "catalog" && versionB.source === "direct") {
      return false;
    }

    // Both are the same source type, check version specificity
    const cleanA = this.cleanVersionString(versionA.resolved);
    const cleanB = this.cleanVersionString(versionB.resolved);

    // Specific versions (no range operators) have highest priority
    const isSpecificA = this.isSpecificVersion(versionA.resolved);
    const isSpecificB = this.isSpecificVersion(versionB.resolved);

    if (isSpecificA && !isSpecificB) return true;
    if (!isSpecificA && isSpecificB) return false;

    // If both are specific or both are ranges, prefer the higher version
    if (semver.valid(cleanA) && semver.valid(cleanB)) {
      return semver.gt(cleanA, cleanB);
    }

    // Fallback to string comparison
    return versionA.resolved > versionB.resolved;
  }

  /**
   * Checks if a version string is a specific version (no range operators)
   */
  private static isSpecificVersion(version: string): boolean {
    return !version.match(/[\^~>=<*]/);
  }

  /**
   * Cleans a version string by removing prefix characters
   */
  private static cleanVersionString(version: string): string {
    return version.replace(/[\^~>=<]/g, "");
  }

  /**
   * Gets all dependencies that use catalog references
   */
  static getCatalogDependencies(
    workspaceInfo: WorkspaceInfo
  ): Map<string, Set<string>> {
    const catalogDeps = new Map<string, Set<string>>();

    for (const workspace of workspaceInfo.packages) {
      const allDeps = {
        ...workspace.dependencies,
        ...workspace.devDependencies,
      };

      for (const [depName, version] of Object.entries(allDeps)) {
        if (version.startsWith("catalog:")) {
          if (!catalogDeps.has(depName)) {
            catalogDeps.set(depName, new Set());
          }
          catalogDeps.get(depName)!.add(workspace.name);
        }
      }
    }

    return catalogDeps;
  }

  /**
   * Determines if a dependency should be updated via catalog or directly
   */
  static shouldUpdateCatalog(
    packageName: string,
    workspaceInfo: WorkspaceInfo
  ): boolean {
    const resolved = this.resolveDependencyVersion(packageName, workspaceInfo);
    return resolved?.source === "catalog";
  }

  /**
   * Gets workspaces that need direct updates (not using catalog)
   */
  static getDirectUpdateWorkspaces(
    packageName: string,
    workspaceInfo: WorkspaceInfo
  ): string[] {
    const directWorkspaces: string[] = [];

    for (const workspace of workspaceInfo.packages) {
      const version =
        workspace.dependencies[packageName] ||
        workspace.devDependencies[packageName];

      if (version && !version.startsWith("catalog:")) {
        directWorkspaces.push(workspace.path);
      }
    }

    return directWorkspaces;
  }
}
