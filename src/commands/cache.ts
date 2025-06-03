import { logger } from "../utils/logger";
import { CacheManager } from "../services/cache-manager";
import { green, yellow, cyan, bold } from "colorette";

export interface CacheOptions {
  clear?: boolean;
  stats?: boolean;
  clean?: boolean;
}

export const manageCache = async (
  options: CacheOptions = {},
  projectPath?: string
): Promise<void> => {
  const cacheManager = new CacheManager(projectPath);

  try {
    if (options.clear) {
      logger.info(yellow("🗑️  Clearing all caches..."));
      cacheManager.clearCache();
      logger.info(green("✅ Cache cleared successfully"));
      return;
    }

    if (options.clean) {
      logger.info(yellow("🧹 Cleaning expired cache entries..."));
      cacheManager.cleanExpiredEntries();
      logger.info(green("✅ Expired cache entries cleaned"));
    }

    if (options.stats || (!options.clear && !options.clean)) {
      logger.info(cyan(bold("📊 Cache Statistics")));
      logger.info("=".repeat(40));

      const stats = cacheManager.getCacheStats();

      logger.info(`${bold("Version Cache:")} ${stats.versionEntries} entries`);
      logger.info(
        `${bold("Workspace Cache:")} ${
          stats.workspaceCached ? "✅ Cached" : "❌ Not cached"
        }`
      );
      logger.info(`${bold("Total Size:")} ${formatBytes(stats.totalSize)}`);

      if (stats.versionEntries > 0) {
        logger.info(
          green(
            `\n💡 Cache is active and contains ${stats.versionEntries} package versions`
          )
        );
        logger.info(
          green(
            "   This will significantly speed up subsequent dependency checks"
          )
        );
      } else {
        logger.info(
          yellow("\n💡 Cache is empty - run a dependency check to populate it")
        );
      }
    }
  } catch (error) {
    logger.error(`Cache operation failed: ${(error as Error).message}`);
  }
};

/**
 * Format bytes to human readable format
 */
function formatBytes(bytes: number): string {
  if (bytes === 0) return "0 Bytes";

  const k = 1024;
  const sizes = ["Bytes", "KB", "MB", "GB"];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
}

// For backwards compatibility
export const cache = manageCache;
