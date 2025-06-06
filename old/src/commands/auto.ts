import { updateDependencies } from "../services/dependency-checker"
import { createPullRequest } from "../services/pr-generator"
import { createBackup } from "./rollback"
import { logger } from "../utils/logger"

export interface AutoUpdateResult {
  updated: Array<{
    name: string
    currentVersion: string
    newVersion: string
  }>
  prCreated: boolean
}

export const autoUpdateDependencies = async (
  args?: any,
): Promise<AutoUpdateResult> => {
  try {
    logger.status("Starting automatic dependency update...", "🚀")

    // Create backup before updating
    if (!args?.dryRun) {
      logger.progress("Creating backup before updates...")
      await createBackup(args?.projectPath)
    }

    const updates = await updateDependencies(args?.projectPath)

    if (updates.length > 0) {
      logger.success(`${updates.length} dependencies updated successfully`)

      if (args?.createIssue || process.env.CREATE_PR === "true") {
        logger.progress("Creating pull request...")
        await createPullRequest(updates)
        logger.success("Pull request created for dependency updates.")
        return { updated: updates, prCreated: true }
      } else {
        logger.status(
          "Skipping PR creation. Run with --createIssue flag or set CREATE_PR=true to create PRs.",
          "ℹ",
        )
        return { updated: updates, prCreated: false }
      }
    } else {
      logger.status("No dependencies need updating.", "✅")
      return { updated: [], prCreated: false }
    }
  } catch (error) {
    logger.error(`Error during auto-update: ${(error as Error).message}`)
    return { updated: [], prCreated: false }
  }
}

// For backwards compatibility
export const autoUpdate = autoUpdateDependencies
