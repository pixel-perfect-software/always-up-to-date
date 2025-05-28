import { Command } from "commander";
import { parseArgs } from "./utils/args";
import { checkDependencies } from "./commands/check";
import { auditDependencies } from "./commands/audit";
import { autoUpdateDependencies } from "./commands/auto";
import { ConfigManager } from "./utils/config";
import { logger } from "./utils/logger";

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
  .action((options, command) => {
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
  .action((options, command) => {
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
  .option("-t, --token <token>", "GitHub token for creating PRs")
  .option(
    "-r, --repository <owner/repo>",
    "GitHub repository in format owner/repo"
  )
  .option("-v, --verbose", "Show verbose output", false)
  .action((options, command) => {
    const args = parseArgs();
    const mergedOptions = { ...args, ...options };

    // Set environment variables if provided via options
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
