import { existsSync, readFileSync } from "fs";
import { join, resolve, relative } from "path";
import { glob } from "glob";
import { logger } from "./logger";
import { WorkspaceInfo, WorkspacePackage } from "../types/workspace";
import { ConfigurationError } from "./errors";
import { CacheManager } from "../services/cache-manager";

// Timeout for workspace detection operations
const WORKSPACE_DETECTION_TIMEOUT = 30000; // 30 seconds
const GLOB_TIMEOUT = 5000; // 5 seconds per glob pattern

const PATHS_TO_IGNORE = [
  "**/node_modules/**",
  "**/.git/**",
  "**/dist/**",
  "**/build/**",
  "**/coverage/**",
  "**/.next/**",
  "**/.nuxt/**",
  "**/.vercel/**",
  "**/.output/**",
  "**/.cache-loader/**",
  "**/.cache-babel-loader/**",
  "**/.cache-webpack/**",
  "**/.cache-vite/**",
  "**/.cache-rollup/**",
  "**/.cache-esbuild/**",
  "**/.cache-swc/**",
  "**/.cache/**",
  "**/tmp/**",
  "**/temp/**",
  "**/logs/**",
  "**/log/**",
  "**/.turbo/**",
  "**/.cache/**",
  "**/bower_components/**",
  "**/jspm_packages/**",
  "**/vendor/**",
  "**/public/**",
  "**/static/**",
  "**/assets/**",
];

export class WorkspaceManager {
  /**
   * Detects if the given path is a monorepo and returns workspace information
   */
  static async detect(
    projectPath: string = process.cwd()
  ): Promise<WorkspaceInfo> {
    const manager = new WorkspaceManager();
    return manager.detectWorkspace(projectPath);
  }

  async detectWorkspace(projectPath: string): Promise<WorkspaceInfo> {
    const rootPath = resolve(projectPath);
    const packageJsonPath = join(rootPath, "package.json");

    if (!existsSync(packageJsonPath)) {
      throw new ConfigurationError(
        `package.json not found at ${packageJsonPath}`
      );
    }

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      const packageManager = this.detectPackageManager(rootPath);
      const workspacePatterns = this.parseWorkspacePatterns(
        packageJson,
        packageManager,
        rootPath
      );

      if (workspacePatterns.length === 0) {
        // Not a monorepo - return single package info
        const rootPackage: WorkspacePackage = {
          name: packageJson.name || "root",
          path: rootPath,
          packageJson,
          dependencies: packageJson.dependencies || {},
          devDependencies: packageJson.devDependencies || {},
          isRoot: true,
        };

        return {
          isMonorepo: false,
          rootPath,
          packages: [rootPackage],
          workspacePatterns: [],
          packageManager,
        };
      }

      // Discover workspace packages with timeout protection
      const packages = await this.getWorkspacePackagesWithTimeout(
        workspacePatterns,
        rootPath
      );

      // Add root package if it has dependencies
      const rootHasDependencies =
        Object.keys(packageJson.dependencies || {}).length > 0 ||
        Object.keys(packageJson.devDependencies || {}).length > 0;

      if (rootHasDependencies) {
        const rootPackage: WorkspacePackage = {
          name: packageJson.name || "root",
          path: rootPath,
          packageJson,
          dependencies: packageJson.dependencies || {},
          devDependencies: packageJson.devDependencies || {},
          isRoot: true,
        };
        packages.unshift(rootPackage);
      }

      logger.debug(`Detected monorepo with ${packages.length} packages`);

      return {
        isMonorepo: true,
        rootPath,
        packages,
        workspacePatterns,
        packageManager,
      };
    } catch (error) {
      throw new ConfigurationError(
        `Failed to detect workspace structure at ${rootPath}`,
        error as Error
      );
    }
  }

  /**
   * Discovers all packages matching the workspace patterns with timeout protection
   */
  private async getWorkspacePackagesWithTimeout(
    patterns: string[],
    rootPath: string
  ): Promise<WorkspacePackage[]> {
    const abortController = new AbortController();
    let timeoutId: ReturnType<typeof setTimeout> | null = null;

    try {
      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          abortController.abort();
          reject(
            new Error(
              `Workspace detection timeout after ${WORKSPACE_DETECTION_TIMEOUT}ms`
            )
          );
        }, WORKSPACE_DETECTION_TIMEOUT);
      });

      const workspacePromise = this.getWorkspacePackages(
        patterns,
        rootPath,
        abortController.signal
      );

      return await Promise.race([workspacePromise, timeoutPromise]);
    } catch (error) {
      logger.warn(
        `Workspace detection timed out or failed: ${(error as Error).message}`
      );
      return [];
    } finally {
      // Clean up timeout and abort controller
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (!abortController.signal.aborted) {
        abortController.abort();
      }
    }
  }

  /**
   * Discovers all packages matching the workspace patterns with caching and parallel processing
   */
  async getWorkspacePackages(
    patterns: string[],
    rootPath: string,
    signal?: AbortSignal
  ): Promise<WorkspacePackage[]> {
    // Check cache first
    const cacheManager = new CacheManager(rootPath);
    if (cacheManager.isWorkspaceCacheValid(rootPath)) {
      const cachedWorkspace = cacheManager.getCachedWorkspace(rootPath);
      if (cachedWorkspace) {
        logger.debug("Using cached workspace structure");
        return this.loadCachedPackages(cachedWorkspace.packages, rootPath);
      }
    }

    const packages: WorkspacePackage[] = [];
    logger.debug(
      `Processing ${patterns.length} workspace patterns in parallel`
    );

    // Process all patterns in parallel instead of sequentially
    const patternPromises = patterns.map(async (pattern) => {
      if (signal?.aborted) {
        throw new Error("Workspace detection aborted");
      }

      try {
        logger.debug(`Processing workspace pattern: ${pattern}`);

        // Use glob to find all matching directories with timeout protection
        const globPromise = glob(pattern + "/package.json", {
          cwd: rootPath,
          absolute: false,
          ignore: PATHS_TO_IGNORE,
          maxDepth: 3, // Optimized depth for monorepo structure
        });

        const timeoutPromise = new Promise<never>((_, reject) => {
          setTimeout(
            () => reject(new Error(`Glob timeout for pattern: ${pattern}`)),
            GLOB_TIMEOUT
          );
        });

        const matches = (await Promise.race([
          globPromise,
          timeoutPromise,
        ])) as string[];

        logger.debug(`Pattern ${pattern} found ${matches.length} matches`);

        // Extract directory paths from package.json matches
        const directories = matches.map((match) =>
          match.replace("/package.json", "")
        );

        return directories;
      } catch (error) {
        logger.warn(
          `Failed to process workspace pattern "${pattern}": ${
            (error as Error).message
          }`
        );
        return [];
      }
    });

    // Wait for all pattern searches to complete
    const allDirectoriesArrays = await Promise.allSettled(patternPromises);
    const allDirectories = allDirectoriesArrays
      .filter((result) => result.status === "fulfilled")
      .flatMap((result) => result.value)
      .filter((dir, index, arr) => arr.indexOf(dir) === index); // Remove duplicates

    logger.debug(`Found ${allDirectories.length} unique workspace directories`);

    // Process all packages in parallel with increased concurrency
    const packagePromises = allDirectories.map(async (directory) => {
      if (signal?.aborted) {
        throw new Error("Workspace detection aborted");
      }
      return this.loadPackageFromDirectory(directory, rootPath);
    });

    const packageResults = await Promise.allSettled(packagePromises);
    for (const result of packageResults) {
      if (result.status === "fulfilled" && result.value) {
        packages.push(result.value);
      }
    }

    // Cache the discovered workspace structure
    try {
      const packagePaths = packages.map((pkg) => relative(rootPath, pkg.path));
      cacheManager.setCachedWorkspace(packagePaths, patterns, rootPath);
    } catch (error) {
      logger.debug(
        `Failed to cache workspace structure: ${(error as Error).message}`
      );
    }

    return packages;
  }

  /**
   * Load packages from cached paths
   */
  private async loadCachedPackages(
    packagePaths: string[],
    rootPath: string
  ): Promise<WorkspacePackage[]> {
    const packages: WorkspacePackage[] = [];

    // Process cached packages in parallel
    const packagePromises = packagePaths.map(async (relativePath) => {
      return this.loadPackageFromDirectory(relativePath, rootPath);
    });

    const results = await Promise.allSettled(packagePromises);
    for (const result of results) {
      if (result.status === "fulfilled" && result.value) {
        packages.push(result.value);
      }
    }

    return packages;
  }

  /**
   * Load a package from a directory
   */
  private async loadPackageFromDirectory(
    directory: string,
    rootPath: string
  ): Promise<WorkspacePackage | null> {
    const packagePath = join(rootPath, directory);
    const packageJsonPath = join(packagePath, "package.json");

    if (!existsSync(packageJsonPath)) {
      return null;
    }

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

      const workspacePackage: WorkspacePackage = {
        name: packageJson.name || directory,
        path: packagePath,
        packageJson,
        dependencies: packageJson.dependencies || {},
        devDependencies: packageJson.devDependencies || {},
        isRoot: false,
      };

      logger.debug(
        `Found workspace package: ${workspacePackage.name} at ${relative(
          rootPath,
          packagePath
        )}`
      );

      return workspacePackage;
    } catch (error) {
      logger.warn(
        `Failed to parse package.json at ${packageJsonPath}: ${
          (error as Error).message
        }`
      );
      return null;
    }
  }

  /**
   * Detects the package manager being used
   */
  private detectPackageManager(rootPath: string): "npm" | "yarn" | "pnpm" {
    if (existsSync(join(rootPath, "pnpm-lock.yaml"))) {
      return "pnpm";
    }
    if (existsSync(join(rootPath, "yarn.lock"))) {
      return "yarn";
    }
    return "npm";
  }

  /**
   * Parses workspace patterns from package.json and workspace config files
   */
  private parseWorkspacePatterns(
    packageJson: any,
    packageManager: "npm" | "yarn" | "pnpm",
    rootPath: string
  ): string[] {
    const patterns: string[] = [];

    // Check for pnpm workspace file
    if (packageManager === "pnpm") {
      const pnpmWorkspacePath = join(rootPath, "pnpm-workspace.yaml");
      if (existsSync(pnpmWorkspacePath)) {
        try {
          const content = readFileSync(pnpmWorkspacePath, "utf8");
          // Simple YAML parsing for packages array
          const lines = content.split("\n");
          let inPackagesSection = false;

          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed === "packages:") {
              inPackagesSection = true;
              continue;
            }
            if (inPackagesSection) {
              if (trimmed.startsWith("- ")) {
                const pattern = trimmed.substring(2).replace(/['"]/g, "");
                patterns.push(pattern);
              } else if (
                trimmed &&
                !trimmed.startsWith("#") &&
                !trimmed.startsWith("-")
              ) {
                // End of packages section
                break;
              }
            }
          }
        } catch (error) {
          logger.warn(
            `Failed to parse pnpm-workspace.yaml: ${(error as Error).message}`
          );
        }
      }
    }

    // Check package.json workspaces field (npm/yarn/pnpm)
    if (packageJson.workspaces) {
      if (Array.isArray(packageJson.workspaces)) {
        patterns.push(...packageJson.workspaces);
      } else if (
        packageJson.workspaces.packages &&
        Array.isArray(packageJson.workspaces.packages)
      ) {
        patterns.push(...packageJson.workspaces.packages);
      }
    }

    // Remove duplicates and normalize patterns
    return [...new Set(patterns)].filter(
      (pattern) => pattern && typeof pattern === "string"
    );
  }

  /**
   * Checks if a package name is an internal workspace dependency
   */
  static isInternalDependency(
    packageName: string,
    workspaces: WorkspacePackage[]
  ): boolean {
    return workspaces.some((workspace) => workspace.name === packageName);
  }

  /**
   * Gets all workspaces that depend on a specific package
   */
  static getWorkspacesDependingOn(
    packageName: string,
    workspaces: WorkspacePackage[]
  ): WorkspacePackage[] {
    return workspaces.filter(
      (workspace) =>
        workspace.dependencies[packageName] ||
        workspace.devDependencies[packageName]
    );
  }

  /**
   * Gets all external dependencies across all workspaces
   */
  static getAllExternalDependencies(
    workspaces: WorkspacePackage[]
  ): Record<string, Set<string>> {
    const allDeps: Record<string, Set<string>> = {};

    for (const workspace of workspaces) {
      const allWorkspaceDeps = {
        ...workspace.dependencies,
        ...workspace.devDependencies,
      };

      for (const [depName, version] of Object.entries(allWorkspaceDeps)) {
        // Skip internal dependencies
        if (!this.isInternalDependency(depName, workspaces)) {
          if (!allDeps[depName]) {
            allDeps[depName] = new Set();
          }
          allDeps[depName].add(version);
        }
      }
    }

    return allDeps;
  }

  /**
   * Finds version conflicts across workspaces
   */
  static findVersionConflicts(
    workspaces: WorkspacePackage[]
  ): Record<string, string[]> {
    const allDeps = this.getAllExternalDependencies(workspaces);
    const conflicts: Record<string, string[]> = {};

    for (const [depName, versions] of Object.entries(allDeps)) {
      if (versions.size > 1) {
        conflicts[depName] = Array.from(versions);
      }
    }

    return conflicts;
  }
}
