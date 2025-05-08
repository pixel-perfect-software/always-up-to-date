import { checkForUpdates } from "../services/dependency-checker";
import { logger } from "../utils/logger";

export interface CheckResult {
  updatable: Array<{
    name: string;
    currentVersion: string;
    installedVersion?: string;
    newVersion: string;
  }>;
  breakingChanges: Array<{
    name: string;
    currentVersion: string;
    installedVersion?: string;
    newVersion: string;
    migrationInstructions?: string;
  }>;
}

export const checkDependencies = async (args?: any): Promise<CheckResult> => {
  try {
    logger.info("Checking for dependency updates...");
    const { updatable, breakingChanges } = await checkForUpdates(
      args?.projectPath
    );

    if (updatable.length === 0 && breakingChanges.length === 0) {
      logger.info("All dependencies are up to date.");
    } else {
      if (updatable.length > 0) {
        logger.info("The following dependencies can be updated:");
        updatable.forEach((update) => {
          if (
            update.installedVersion &&
            update.installedVersion !== update.currentVersion
          ) {
            logger.info(
              `- ${update.name}: ${update.currentVersion} (defined in package.json) / ${update.installedVersion} (actually installed) → ${update.newVersion}`
            );
          } else {
            logger.info(
              `- ${update.name}: ${update.currentVersion} → ${update.newVersion}`
            );
          }
        });
      }

      if (breakingChanges.length > 0) {
        logger.warn("The following dependencies have breaking changes:");
        breakingChanges.forEach((update) => {
          if (
            update.installedVersion &&
            update.installedVersion !== update.currentVersion
          ) {
            logger.warn(
              `- ${update.name}: ${update.currentVersion} (defined in package.json) / ${update.installedVersion} (actually installed) → ${update.newVersion}`
            );
          } else {
            logger.warn(
              `- ${update.name}: ${update.currentVersion} → ${update.newVersion}`
            );
          }
          if (update.migrationInstructions) {
            logger.debug("Migration instructions available");
          }
        });
      }
    }

    return {
      updatable,
      breakingChanges,
    };
  } catch (error) {
    logger.error(
      `An error occurred while checking dependencies: ${
        (error as Error).message
      }`
    );
    return { updatable: [], breakingChanges: [] };
  }
};

// For backwards compatibility with older code that might use this
export const check = checkDependencies;
