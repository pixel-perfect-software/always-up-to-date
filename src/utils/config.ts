import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { logger } from "./logger";
import { ConfigurationError } from "./errors";

export interface AlwaysUpToDateConfig {
  // Package management
  autoUpdate: boolean;
  createPRs: boolean;

  // Filtering
  ignoredPackages: string[];
  includeDev: boolean;
  onlyDirect: boolean;

  // GitHub settings
  githubToken?: string;
  repository?: string;
  baseBranch: string;

  // Update strategy
  allowMajorUpdates: boolean;
  allowPrerelease: boolean;

  // Scheduling (for future use)
  schedule?: string;

  // Retry settings
  retryAttempts: number;
  retryDelay: number;
}

const DEFAULT_CONFIG: AlwaysUpToDateConfig = {
  autoUpdate: false,
  createPRs: false,
  ignoredPackages: [],
  includeDev: true,
  onlyDirect: false,
  baseBranch: "main",
  allowMajorUpdates: false,
  allowPrerelease: false,
  retryAttempts: 3,
  retryDelay: 1000,
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

  public shouldIncludeDev(): boolean {
    return this.config.includeDev;
  }

  public getRetryConfig(): { attempts: number; delay: number } {
    return {
      attempts: this.config.retryAttempts,
      delay: this.config.retryDelay,
    };
  }

  public getGitHubConfig(): {
    token?: string;
    repository?: string;
    baseBranch: string;
  } {
    return {
      token: this.config.githubToken || process.env.GITHUB_TOKEN,
      repository:
        this.config.repository ||
        (process.env.REPO_OWNER && process.env.REPO_NAME)
          ? `${process.env.REPO_OWNER}/${process.env.REPO_NAME}`
          : undefined,
      baseBranch: this.config.baseBranch,
    };
  }

  public static createSampleConfig(projectPath: string = process.cwd()): void {
    const configPath = join(projectPath, ".alwaysuptodate.json");
    const sampleConfig: AlwaysUpToDateConfig = {
      ...DEFAULT_CONFIG,
      ignoredPackages: ["@types/node", "typescript"],
      allowMajorUpdates: false,
      createPRs: true,
    };

    try {
      const fs = require("fs");
      fs.writeFileSync(
        configPath,
        JSON.stringify(sampleConfig, null, 2),
        "utf8"
      );
      logger.info(`Sample configuration created at ${configPath}`);
    } catch (error) {
      throw new ConfigurationError(
        `Failed to create sample configuration at ${configPath}`,
        error as Error
      );
    }
  }
}
