import { updateDependencies } from "../services/dependency-checker";
import { createPullRequest } from "../services/pr-generator";
import { logger } from "../utils/logger";

export interface AutoUpdateResult {
  updated: Array<{
    name: string;
    currentVersion: string;
    newVersion: string;
  }>;
  prCreated: boolean;
}

export const autoUpdateDependencies = async (
  args?: any
): Promise<AutoUpdateResult> => {
  try {
    logger.info("Starting automatic dependency update...");
    const updates = await updateDependencies(args?.projectPath);

    if (updates.length > 0) {
      logger.info(`${updates.length} dependencies updated successfully`);

      if (args?.createIssue || process.env.CREATE_PR === "true") {
        await createPullRequest(updates);
        logger.info("Pull request created for dependency updates.");
        return { updated: updates, prCreated: true };
      } else {
        logger.info(
          "Skipping PR creation. Run with --createIssue flag or set CREATE_PR=true to create PRs."
        );
        return { updated: updates, prCreated: false };
      }
    } else {
      logger.info("No dependencies need updating.");
      return { updated: [], prCreated: false };
    }
  } catch (error) {
    logger.error(`Error during auto-update: ${(error as Error).message}`);
    return { updated: [], prCreated: false };
  }
};

// For backwards compatibility
export const autoUpdate = autoUpdateDependencies;
