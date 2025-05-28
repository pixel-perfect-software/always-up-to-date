import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { logger } from "./logger";
import { ConfigurationError } from "./errors";

export type UpdateStrategy = "major" | "minor" | "patch" | "none";

export interface PackageRule {
  /** Package name or glob pattern */
  name: string;
  /** Update strategy for this package */
  updateStrategy: UpdateStrategy;
  /** Whether to auto-update this package */
  autoUpdate?: boolean;
  /** Custom ignored versions (e.g., known problematic versions) */
  ignoredVersions?: string[];
  /** Minimum Node.js version required for updates */
  requiredNodeVersion?: string;
}

export interface ScheduleConfig {
  /** Whether scheduling is enabled */
  enabled: boolean;
  /** Cron expression for when to run updates */
  cron?: string;
  /** Days of week to run (0-6, Sunday-Saturday) */
  daysOfWeek?: number[];
  /** Hour of day to run (0-23) */
  hour?: number;
  /** Whether to run on weekends */
  includeWeekends?: boolean;
}

export interface AlwaysUpToDateConfig {
  // Package management
  autoUpdate: boolean;
  createPRs: boolean;

  // Filtering
  ignoredPackages: string[];
  includeDev: boolean;
  onlyDirect: boolean;

  // Package-specific rules
  packageRules: PackageRule[];

  // GitHub settings
  githubToken?: string;
  repository?: string;
  baseBranch: string;

  // Update strategy (global defaults)
  allowMajorUpdates: boolean;
  allowPrerelease: boolean;
  defaultUpdateStrategy: UpdateStrategy;

  // Scheduling
  schedule: ScheduleConfig;

  // Advanced options
  batchSize: number;
  parallelUpdates: boolean;
  createSeparatePRs: boolean;
  lockFileUpdate: boolean;

  // Retry settings
  retryAttempts: number;
  retryDelay: number;

  // Preview and safety
  dryRun: boolean;
  confirmBeforeUpdate: boolean;
}

const DEFAULT_CONFIG: AlwaysUpToDateConfig = {
  autoUpdate: false,
  createPRs: false,
  ignoredPackages: [],
  includeDev: true,
  onlyDirect: false,
  packageRules: [],
  baseBranch: "main",
  allowMajorUpdates: false,
  allowPrerelease: false,
  defaultUpdateStrategy: "minor",
  schedule: {
    enabled: false,
    includeWeekends: false,
  },
  batchSize: 10,
  parallelUpdates: true,
  createSeparatePRs: false,
  lockFileUpdate: true,
  retryAttempts: 3,
  retryDelay: 1000,
  dryRun: false,
  confirmBeforeUpdate: false,
};

export class ConfigManager {
  private config: AlwaysUpToDateConfig;
  private configPath: string;

  constructor(projectPath: string = process.cwd()) {
    this.configPath = join(projectPath, ".alwaysuptodate.json");
    this.config = this.loadConfig();
  }

  private loadConfig(): AlwaysUpToDateConfig {
    try {
      if (existsSync(this.configPath)) {
        logger.debug(`Loading config from ${this.configPath}`);
        const fileContent = readFileSync(this.configPath, "utf8");
        const userConfig = JSON.parse(fileContent);

        // Validate and merge with defaults
        return { ...DEFAULT_CONFIG, ...userConfig };
      }

      logger.debug("No config file found, using defaults");
      return { ...DEFAULT_CONFIG };
    } catch (error) {
      throw new ConfigurationError(
        `Failed to load configuration from ${this.configPath}`,
        error as Error
      );
    }
  }

  public getConfig(): AlwaysUpToDateConfig {
    return { ...this.config };
  }

  public updateConfig(updates: Partial<AlwaysUpToDateConfig>): void {
    this.config = { ...this.config, ...updates };
  }

  public shouldIgnorePackage(packageName: string): boolean {
    return this.config.ignoredPackages.includes(packageName);
  }

  public shouldAllowMajorUpdate(): boolean {
    return this.config.allowMajorUpdates;
  }

  /**
   * Get update strategy for a specific package
   */
  public getUpdateStrategyForPackage(packageName: string): UpdateStrategy {
    // Check for specific package rules first
    const packageRule = this.config.packageRules.find((rule) => {
      // Support glob patterns in the future
      return (
        rule.name === packageName || this.matchesPattern(rule.name, packageName)
      );
    });

    if (packageRule) {
      return packageRule.updateStrategy;
    }

    // Fall back to global defaults
    return this.config.defaultUpdateStrategy;
  }

  /**
   * Check if a package should be auto-updated
   */
  public shouldAutoUpdatePackage(packageName: string): boolean {
    const packageRule = this.config.packageRules.find(
      (rule) =>
        rule.name === packageName || this.matchesPattern(rule.name, packageName)
    );

    if (packageRule && packageRule.autoUpdate !== undefined) {
      return packageRule.autoUpdate;
    }

    return this.config.autoUpdate;
  }

  /**
   * Check if a version should be ignored for a package
   */
  public shouldIgnoreVersion(packageName: string, version: string): boolean {
    const packageRule = this.config.packageRules.find(
      (rule) =>
        rule.name === packageName || this.matchesPattern(rule.name, packageName)
    );

    if (packageRule && packageRule.ignoredVersions) {
      return packageRule.ignoredVersions.includes(version);
    }

    return false;
  }

  /**
   * Get schedule configuration
   */
  public getScheduleConfig(): ScheduleConfig {
    return this.config.schedule;
  }

  /**
   * Check if updates should run in dry-run mode
   */
  public isDryRun(): boolean {
    return this.config.dryRun;
  }

  /**
   * Check if confirmation is required before updates
   */
  public requiresConfirmation(): boolean {
    return this.config.confirmBeforeUpdate;
  }

  /**
   * Get batch size for updates
   */
  public getBatchSize(): number {
    return this.config.batchSize;
  }

  /**
   * Check if parallel updates are enabled
   */
  public isParallelUpdatesEnabled(): boolean {
    return this.config.parallelUpdates;
  }

  /**
   * Check if separate PRs should be created for each update
   */
  public shouldCreateSeparatePRs(): boolean {
    return this.config.createSeparatePRs;
  }

  /**
   * Simple pattern matching for package names (supports basic wildcards)
   */
  private matchesPattern(pattern: string, packageName: string): boolean {
    if (pattern === packageName) {
      return true;
    }

    // Simple wildcard support
    if (pattern.includes("*")) {
      const regex = new RegExp(pattern.replace(/\*/g, ".*"));
      return regex.test(packageName);
    }

    // Support for scope matching (e.g., "@types/*")
    if (pattern.startsWith("@") && pattern.includes("/*")) {
      const scope = pattern.replace("/*", "");
      return packageName.startsWith(scope + "/");
    }

    return false;
  }

  /**
   * Create a sample configuration file with advanced options
   */
  static createSampleConfig(projectPath: string = process.cwd()): void {
    const { writeFileSync } = require("fs");
    const configPath = join(projectPath, ".alwaysuptodate.json");

    const sampleConfig: AlwaysUpToDateConfig = {
      // Package management
      autoUpdate: false,
      createPRs: true,

      // Filtering
      ignoredPackages: ["@types/node", "typescript"],
      includeDev: true,
      onlyDirect: false,

      // Package-specific rules
      packageRules: [
        {
          name: "react",
          updateStrategy: "minor",
          autoUpdate: false,
          ignoredVersions: ["19.0.0-beta.1"],
        },
        {
          name: "@types/*",
          updateStrategy: "patch",
          autoUpdate: true,
        },
        {
          name: "eslint",
          updateStrategy: "minor",
          autoUpdate: false,
        },
      ],

      // GitHub settings
      baseBranch: "main",

      // Update strategy (global defaults)
      allowMajorUpdates: false,
      allowPrerelease: false,
      defaultUpdateStrategy: "minor",

      // Scheduling
      schedule: {
        enabled: false,
        daysOfWeek: [1, 2, 3, 4, 5], // Monday-Friday
        hour: 9,
        includeWeekends: false,
      },

      // Advanced options
      batchSize: 5,
      parallelUpdates: true,
      createSeparatePRs: false,
      lockFileUpdate: true,

      // Retry settings
      retryAttempts: 3,
      retryDelay: 1000,

      // Preview and safety
      dryRun: false,
      confirmBeforeUpdate: false,
    };

    writeFileSync(configPath, JSON.stringify(sampleConfig, null, 2));
    logger.info(`Sample configuration created at ${configPath}`);
  }
}
