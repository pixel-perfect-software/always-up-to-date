import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { logger } from "../utils/logger";

interface CacheEntry {
  version: string;
  timestamp: number;
  packageManager: string;
}

interface WorkspaceCacheEntry {
  packages: string[];
  patterns: string[];
  timestamp: number;
  rootPath: string;
}

export class CacheManager {
  private cacheDir: string;
  private versionCacheFile: string;
  private workspaceCacheFile: string;
  private readonly VERSION_CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
  private readonly WORKSPACE_CACHE_TTL = 24 * 60 * 60 * 1000; // 24 hours
  private readonly STABLE_PACKAGE_TTL = 24 * 60 * 60 * 1000; // 24 hours for stable packages

  constructor(projectPath: string = process.cwd()) {
    this.cacheDir = join(projectPath, ".alwaysuptodate");
    this.versionCacheFile = join(this.cacheDir, "version-cache.json");
    this.workspaceCacheFile = join(this.cacheDir, "workspace-cache.json");
    this.ensureCacheDirectory();
  }

  /**
   * Ensure cache directory exists
   */
  private ensureCacheDirectory(): void {
    if (!existsSync(this.cacheDir)) {
      try {
        mkdirSync(this.cacheDir, { recursive: true });
        logger.debug(`Created cache directory: ${this.cacheDir}`);
      } catch (error) {
        logger.warn(
          `Failed to create cache directory: ${(error as Error).message}`
        );
      }
    }
  }

  /**
   * Get cached version for a package
   */
  getCachedVersion(
    packageName: string,
    packageManager: string = "npm"
  ): string | null {
    try {
      if (!existsSync(this.versionCacheFile)) {
        return null;
      }

      const cache = JSON.parse(readFileSync(this.versionCacheFile, "utf8"));
      const entry = cache[packageName] as CacheEntry | undefined;

      if (!entry) {
        return null;
      }

      const now = Date.now();
      const age = now - entry.timestamp;

      // Use different TTL based on package stability
      const isStablePackage = this.isStablePackage(packageName);
      const ttl = isStablePackage
        ? this.STABLE_PACKAGE_TTL
        : this.VERSION_CACHE_TTL;

      if (age > ttl || entry.packageManager !== packageManager) {
        return null;
      }

      logger.debug(
        `Cache hit for ${packageName}: ${entry.version} (age: ${Math.round(
          age / 1000
        )}s)`
      );
      return entry.version;
    } catch (error) {
      logger.debug(`Error reading version cache: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Cache version for a package
   */
  setCachedVersion(
    packageName: string,
    version: string,
    packageManager: string = "npm"
  ): void {
    try {
      let cache: Record<string, CacheEntry> = {};

      if (existsSync(this.versionCacheFile)) {
        try {
          cache = JSON.parse(readFileSync(this.versionCacheFile, "utf8"));
        } catch (error) {
          logger.debug("Invalid cache file, starting fresh");
        }
      }

      cache[packageName] = {
        version,
        timestamp: Date.now(),
        packageManager,
      };

      writeFileSync(this.versionCacheFile, JSON.stringify(cache, null, 2));
      logger.debug(`Cached version for ${packageName}: ${version}`);
    } catch (error) {
      logger.debug(`Error writing version cache: ${(error as Error).message}`);
    }
  }

  /**
   * Get cached versions for multiple packages
   */
  getCachedVersions(
    packageNames: string[],
    packageManager: string = "npm"
  ): Map<string, string> {
    const cachedVersions = new Map<string, string>();

    for (const packageName of packageNames) {
      const version = this.getCachedVersion(packageName, packageManager);
      if (version) {
        cachedVersions.set(packageName, version);
      }
    }

    return cachedVersions;
  }

  /**
   * Cache versions for multiple packages
   */
  setCachedVersions(
    versions: Map<string, string>,
    packageManager: string = "npm"
  ): void {
    try {
      let cache: Record<string, CacheEntry> = {};

      if (existsSync(this.versionCacheFile)) {
        try {
          cache = JSON.parse(readFileSync(this.versionCacheFile, "utf8"));
        } catch (error) {
          logger.debug("Invalid cache file, starting fresh");
        }
      }

      const timestamp = Date.now();
      for (const [packageName, version] of versions) {
        cache[packageName] = {
          version,
          timestamp,
          packageManager,
        };
      }

      writeFileSync(this.versionCacheFile, JSON.stringify(cache, null, 2));
      logger.debug(`Bulk cached ${versions.size} package versions`);
    } catch (error) {
      logger.debug(
        `Error writing bulk version cache: ${(error as Error).message}`
      );
    }
  }

  /**
   * Get cached workspace structure
   */
  getCachedWorkspace(rootPath: string): WorkspaceCacheEntry | null {
    try {
      if (!existsSync(this.workspaceCacheFile)) {
        return null;
      }

      const cache = JSON.parse(
        readFileSync(this.workspaceCacheFile, "utf8")
      ) as WorkspaceCacheEntry;

      if (cache.rootPath !== rootPath) {
        return null;
      }

      const now = Date.now();
      const age = now - cache.timestamp;

      if (age > this.WORKSPACE_CACHE_TTL) {
        return null;
      }

      logger.debug(`Workspace cache hit (age: ${Math.round(age / 1000)}s)`);
      return cache;
    } catch (error) {
      logger.debug(
        `Error reading workspace cache: ${(error as Error).message}`
      );
      return null;
    }
  }

  /**
   * Cache workspace structure
   */
  setCachedWorkspace(
    packages: string[],
    patterns: string[],
    rootPath: string
  ): void {
    try {
      const cache: WorkspaceCacheEntry = {
        packages,
        patterns,
        timestamp: Date.now(),
        rootPath,
      };

      writeFileSync(this.workspaceCacheFile, JSON.stringify(cache, null, 2));
      logger.debug(
        `Cached workspace structure with ${packages.length} packages`
      );
    } catch (error) {
      logger.debug(
        `Error writing workspace cache: ${(error as Error).message}`
      );
    }
  }

  /**
   * Check if workspace files have changed since cache
   */
  isWorkspaceCacheValid(rootPath: string): boolean {
    const cachedWorkspace = this.getCachedWorkspace(rootPath);
    if (!cachedWorkspace) {
      return false;
    }

    try {
      // Check if workspace files have been modified since cache
      const workspaceFiles = [
        join(rootPath, "package.json"),
        join(rootPath, "pnpm-workspace.yaml"),
        join(rootPath, "yarn.lock"),
        join(rootPath, "pnpm-lock.yaml"),
        join(rootPath, "package-lock.json"),
      ];

      const cacheTime = cachedWorkspace.timestamp;

      for (const file of workspaceFiles) {
        if (existsSync(file)) {
          const stats = require("fs").statSync(file);
          if (stats.mtime.getTime() > cacheTime) {
            logger.debug(`Workspace file ${file} modified since cache`);
            return false;
          }
        }
      }

      return true;
    } catch (error) {
      logger.debug(
        `Error checking workspace cache validity: ${(error as Error).message}`
      );
      return false;
    }
  }

  /**
   * Clear all caches
   */
  clearCache(): void {
    try {
      if (existsSync(this.versionCacheFile)) {
        require("fs").unlinkSync(this.versionCacheFile);
        logger.info("Cleared version cache");
      }

      if (existsSync(this.workspaceCacheFile)) {
        require("fs").unlinkSync(this.workspaceCacheFile);
        logger.info("Cleared workspace cache");
      }
    } catch (error) {
      logger.warn(`Error clearing cache: ${(error as Error).message}`);
    }
  }

  /**
   * Clean expired cache entries
   */
  cleanExpiredEntries(): void {
    try {
      // Clean version cache
      if (existsSync(this.versionCacheFile)) {
        const cache = JSON.parse(readFileSync(this.versionCacheFile, "utf8"));
        const now = Date.now();
        let cleaned = 0;

        for (const [packageName, entry] of Object.entries(cache)) {
          const cacheEntry = entry as CacheEntry;
          const age = now - cacheEntry.timestamp;
          const isStable = this.isStablePackage(packageName);
          const ttl = isStable
            ? this.STABLE_PACKAGE_TTL
            : this.VERSION_CACHE_TTL;

          if (age > ttl) {
            delete cache[packageName];
            cleaned++;
          }
        }

        if (cleaned > 0) {
          writeFileSync(this.versionCacheFile, JSON.stringify(cache, null, 2));
          logger.debug(`Cleaned ${cleaned} expired cache entries`);
        }
      }

      // Clean workspace cache if expired
      if (existsSync(this.workspaceCacheFile)) {
        const cache = JSON.parse(
          readFileSync(this.workspaceCacheFile, "utf8")
        ) as WorkspaceCacheEntry;
        const age = Date.now() - cache.timestamp;

        if (age > this.WORKSPACE_CACHE_TTL) {
          require("fs").unlinkSync(this.workspaceCacheFile);
          logger.debug("Cleaned expired workspace cache");
        }
      }
    } catch (error) {
      logger.debug(
        `Error cleaning expired cache entries: ${(error as Error).message}`
      );
    }
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): {
    versionEntries: number;
    workspaceCached: boolean;
    totalSize: number;
  } {
    let versionEntries = 0;
    let workspaceCached = false;
    let totalSize = 0;

    try {
      if (existsSync(this.versionCacheFile)) {
        const versionCache = JSON.parse(
          readFileSync(this.versionCacheFile, "utf8")
        );
        versionEntries = Object.keys(versionCache).length;
        totalSize += require("fs").statSync(this.versionCacheFile).size;
      }

      if (existsSync(this.workspaceCacheFile)) {
        workspaceCached = true;
        totalSize += require("fs").statSync(this.workspaceCacheFile).size;
      }
    } catch (error) {
      logger.debug(`Error getting cache stats: ${(error as Error).message}`);
    }

    return { versionEntries, workspaceCached, totalSize };
  }

  /**
   * Determine if a package is considered stable (less frequent updates)
   */
  private isStablePackage(packageName: string): boolean {
    // Consider these packages stable and cache them longer
    const stablePackages = [
      "react",
      "react-dom",
      "lodash",
      "moment",
      "express",
      "axios",
      "typescript",
      "@types/node",
      "@types/react",
      "eslint",
      "prettier",
      "jest",
      "webpack",
      "babel",
    ];

    return stablePackages.some(
      (stable) =>
        packageName === stable ||
        packageName.startsWith(`${stable}/`) ||
        packageName.startsWith(`@${stable}/`) ||
        packageName.startsWith(`@types/${stable}`)
    );
  }
}
