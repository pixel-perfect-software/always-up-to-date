// filepath: /always-up-to-date/always-up-to-date/src/services/dependency-checker.ts
import { execSync } from "child_process";
import { promises as fs } from "fs";
import path from "path";
import npmWrapper from "../utils/npm-wrapper";
import { logger } from "../utils/logger";
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
  constructor(private projectPath: string = process.cwd()) {}

  /**
   * Checks for available updates for all dependencies
   * @returns Object containing updatable dependencies and breaking changes
   */
  async checkForUpdates(): Promise<{
    updatable: DependencyUpdate[];
    breakingChanges: DependencyUpdate[];
  }> {
    try {
      const dependencies = await npmWrapper.getDependencies(this.projectPath);
      const updatable: DependencyUpdate[] = [];
      const breakingChanges: DependencyUpdate[] = [];

      for (const [pkg, currentVersion] of Object.entries(dependencies)) {
        const latestVersion = await this.getLatestVersion(pkg);
        const installedVersion = await npmWrapper.getInstalledVersion(
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
          if (
            this.hasBreakingChanges(cleanCurrentVersion, latestVersion) ||
            (cleanInstalledVersion &&
              this.hasBreakingChanges(cleanInstalledVersion, latestVersion))
          ) {
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
        await npmWrapper.updateDependency(
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
      const command = `npm show ${pkg} version`;
      return execSync(command).toString().trim();
    } catch (error) {
      logger.error(
        `Error getting latest version for ${pkg}: ${(error as Error).message}`
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
   * Gets migration instructions for breaking changes
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
      // First try to find migration guide or release notes
      const commands = [
        `npm view ${pkg} homepage`,
        `npm view ${pkg} repository.url`,
      ];

      for (const command of commands) {
        try {
          const url = execSync(command).toString().trim();
          if (url) {
            return (
              `Major version change detected for ${pkg} (${currentVersion} → ${latestVersion}).\n\n` +
              `Check the package's documentation at ${url} for migration instructions.\n\n` +
              `You may need to update your code to accommodate breaking changes.`
            );
          }
        } catch (e) {
          // Ignore errors and try next command
        }
      }

      return (
        `Major version change detected for ${pkg} (${currentVersion} → ${latestVersion}).\n\n` +
        `Please review the package's documentation for migration instructions.`
      );
    } catch (error) {
      logger.error(
        `Error getting migration instructions for ${pkg}: ${
          (error as Error).message
        }`
      );
      return `Unable to fetch migration instructions for ${pkg}.`;
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
