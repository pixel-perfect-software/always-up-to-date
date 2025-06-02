#!/usr/bin/env node

import { Command } from "commander";
import { parseArgs } from "./utils/args";
import { checkDependencies } from "./commands/check";
import { auditDependencies } from "./commands/audit";
import { autoUpdateDependencies } from "./commands/auto";
import { showDependencyDiff } from "./commands/diff";
import { rollbackDependencies } from "./commands/rollback";
import { migrateCommand } from "./commands/migrate";
import { ConfigManager } from "./utils/config";
import { logger } from "./utils/logger";
import { getGitHubToken } from "./utils/auth";

// Create a program instance
const program = new Command();

// Configure program metadata
program
  .name("alwaysuptodate")
  .description("A CLI tool to keep your npm dependencies up to date")
  .version("1.0.0");

// Configure global help options
program.configureHelp({
  sortSubcommands: true,
  sortOptions: true,
});

// Register commands
program
  .command("check")
  .description("Check for outdated dependencies")
  .option("-p, --projectPath <path>", "Path to the project directory")
  .option("-v, --verbose", "Show verbose output", false)
  .option(
    "--preview",
    "Preview mode - show what would be updated without making changes",
    false
  )
  .option("--interactive", "Interactive mode - ask before each update", false)
  .action((options) => {
    const args = parseArgs();
    const mergedOptions = { ...args, ...options };
    const mergedOptionsString = JSON.stringify(mergedOptions, null, 2);
    if (mergedOptions.verbose) {
      logger.info(`Running check command with options: ${mergedOptionsString}`);
    }
    checkDependencies(mergedOptions);
  });

program
  .command("audit")
  .description("Audit dependencies for vulnerabilities")
  .option("-p, --projectPath <path>", "Path to the project directory")
  .option("-v, --verbose", "Show verbose output", false)
  .action((options) => {
    const args = parseArgs();
    const mergedOptions = { ...args, ...options };
    const mergedOptionsString = JSON.stringify(mergedOptions, null, 2);
    if (mergedOptions.verbose) {
      logger.info(`Running audit command with options: ${mergedOptionsString}`);
    }

    auditDependencies();
  });

program
  .command("auto")
  .description("Automatically update dependencies and create PRs if necessary")
  .option("-p, --projectPath <path>", "Path to the project directory")
  .option("-c, --createIssue", "Create a pull request with the updates", false)
  .option(
    "-t, --token <token>",
    "GitHub token for creating PRs (optional - will auto-detect)"
  )
  .option(
    "-r, --repository <owner/repo>",
    "GitHub repository in format owner/repo (optional - will auto-detect)"
  )
  .option("-v, --verbose", "Show verbose output", false)
  .option(
    "--dry-run",
    "Dry run mode - show what would be done without making changes",
    false
  )
  .option(
    "--batch-size <size>",
    "Number of packages to update in each batch",
    "10"
  )
  .option("--separate-prs", "Create separate PRs for each major update", false)
  .action(async (options) => {
    const args = parseArgs();
    const mergedOptions = { ...args, ...options };

    // Set environment variables if provided via options (for backward compatibility)
    if (mergedOptions.token) {
      process.env.GITHUB_TOKEN = mergedOptions.token;
    }

    if (mergedOptions.repository) {
      const [owner, repo] = mergedOptions.repository.split("/");
      if (owner && repo) {
        process.env.REPO_OWNER = owner;
        process.env.REPO_NAME = repo;
      }
    }

    // Pre-load authentication if creating PRs
    if (mergedOptions.createIssue) {
      logger.info("🔑 Setting up GitHub authentication...");
      const token = await getGitHubToken(mergedOptions.token);
      if (!token) {
        logger.warn(
          "GitHub authentication not available. PR creation will be skipped."
        );
        mergedOptions.createIssue = false;
      } else {
        logger.info("✅ GitHub authentication ready");
      }
    }

    if (mergedOptions.verbose) {
      const mergedOptionsString = JSON.stringify(mergedOptions, null, 2);
      logger.info(`Running auto command with options: ${mergedOptionsString}`);
    }

    autoUpdateDependencies(mergedOptions);
  });

program
  .command("init")
  .description("Create a sample configuration file")
  .option(
    "-p, --projectPath <path>",
    "Path to the project directory",
    process.cwd()
  )
  .action((options) => {
    try {
      ConfigManager.createSampleConfig(options.projectPath);
    } catch (error) {
      logger.error(
        `Failed to create configuration: ${(error as Error).message}`
      );
      process.exit(1);
    }
  });

program
  .command("rollback")
  .description("Rollback recent dependency updates")
  .option("-p, --projectPath <path>", "Path to the project directory")
  .option("-v, --verbose", "Show verbose output", false)
  .option("--keep-backup", "Keep backup file after rollback", false)
  .action((options) => {
    const args = parseArgs();
    const mergedOptions = { ...args, ...options };

    if (mergedOptions.verbose) {
      const mergedOptionsString = JSON.stringify(mergedOptions, null, 2);
      logger.info(
        `Running rollback command with options: ${mergedOptionsString}`
      );
    }

    rollbackDependencies(mergedOptions);
  });

program
  .command("diff")
  .description("Show detailed diff of dependency changes")
  .option("-p, --projectPath <path>", "Path to the project directory")
  .option("-v, --verbose", "Show verbose output", false)
  .option(
    "--format <format>",
    "Output format: table, json, or detailed",
    "detailed"
  )
  .action((options) => {
    const args = parseArgs();
    const mergedOptions = { ...args, ...options };

    if (mergedOptions.verbose) {
      const mergedOptionsString = JSON.stringify(mergedOptions, null, 2);
      logger.info(`Running diff command with options: ${mergedOptionsString}`);
    }

    showDependencyDiff(mergedOptions);
  });

program
  .command("migrate")
  .description("Get migration instructions for package updates")
  .option(
    "-p, --projectPath <path>",
    "Path to the project directory",
    process.cwd()
  )
  .option(
    "--package <package>",
    "Specific package to get migration instructions for"
  )
  .option("--from-version <version>", "Current version of the package")
  .option("--to-version <version>", "Target version for migration")
  .option("-v, --verbose", "Show verbose output", false)
  .option("--list-supported", "List all packages with migration support", false)
  .option(
    "--search-tag <tag>",
    "Search packages by tag (framework, testing, etc.)"
  )
  .option(
    "--custom-rules <path>",
    "Path to directory with custom migration rules"
  )
  .action((options) => {
    const args = parseArgs();
    const mergedOptions = { ...args, ...options };

    if (mergedOptions.verbose) {
      const mergedOptionsString = JSON.stringify(mergedOptions, null, 2);
      logger.info(
        `Running migrate command with options: ${mergedOptionsString}`
      );
    }

    migrateCommand(mergedOptions);
  });

// Export a function that runs the CLI
export const run = async (): Promise<void> => {
  try {
    await program.parseAsync();
  } catch (error) {
    logger.error(`CLI execution error: ${(error as Error).message}`);
    throw error;
  }
};

// If this file is run directly, execute the CLI
if (require.main === module) {
  run().catch((error) => {
    console.error("An error occurred:", error);
    process.exit(1);
  });
}
