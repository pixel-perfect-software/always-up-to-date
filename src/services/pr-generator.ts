import { Octokit } from "@octokit/rest";
import { execSync } from "child_process";
import { readFileSync } from "fs";
import { join } from "path";
import { logger } from "../utils/logger";

interface PullRequestOptions {
  title: string;
  body: string;
  branch: string;
  baseBranch?: string;
}

interface DependencyUpdate {
  name: string;
  currentVersion: string;
  newVersion: string;
  hasBreakingChanges: boolean;
  migrationInstructions?: string;
}

export class PRGenerator {
  private octokit: Octokit;
  private repoOwner: string;
  private repoName: string;

  constructor(token: string, repoOwner: string, repoName: string) {
    this.octokit = new Octokit({ auth: token });
    this.repoOwner = repoOwner;
    this.repoName = repoName;
  }

  public async createPullRequest(options: PullRequestOptions): Promise<void> {
    try {
      // Make sure we're on the right branch first
      const currentBranch = this.getCurrentBranch();

      if (currentBranch !== options.branch) {
        this.createAndCheckoutBranch(options.branch);
      }

      // Check if there are any changes to commit
      if (!this.hasChangesToCommit()) {
        logger.info("No changes to commit for PR.");
        return;
      }

      // Stage all changes
      execSync("git add .", { stdio: "inherit" });

      // Commit the changes
      execSync(`git commit -m "${options.title}"`, { stdio: "inherit" });

      // Push the changes
      execSync(`git push origin ${options.branch}`, { stdio: "inherit" });

      // Create PR
      await this.octokit.pulls.create({
        owner: this.repoOwner,
        repo: this.repoName,
        title: options.title,
        body: options.body,
        head: options.branch,
        base: options.baseBranch || "main",
      });

      logger.info(`Pull request created successfully: ${options.title}`);
    } catch (error) {
      logger.error(`Error creating PR: ${(error as Error).message}`);
      throw error;
    }
  }

  public async generatePRForDependencyUpdate(
    updates: DependencyUpdate[]
  ): Promise<void> {
    if (updates.length === 0) {
      logger.info("No updates to create a PR for");
      return;
    }

    const date = new Date().toISOString().split("T")[0];
    const branchName = `dependency-updates-${date}`;

    // Generate PR title and body
    const title = `chore(deps): update dependencies ${date}`;

    let body = "## Dependency Updates\n\n";
    body += "This PR updates the following dependencies:\n\n";

    const regularUpdates = updates.filter(
      (update) => !update.hasBreakingChanges
    );
    const breakingChanges = updates.filter(
      (update) => update.hasBreakingChanges
    );

    if (regularUpdates.length > 0) {
      body += "### Regular Updates\n\n";
      regularUpdates.forEach((update) => {
        body += `- ${update.name}: ${update.currentVersion} → ${update.newVersion}\n`;
      });
      body += "\n";
    }

    if (breakingChanges.length > 0) {
      body += "### Breaking Changes\n\n";
      body +=
        "The following dependencies have breaking changes that require attention:\n\n";

      breakingChanges.forEach((update) => {
        body += `#### ${update.name}: ${update.currentVersion} → ${update.newVersion}\n\n`;
        if (update.migrationInstructions) {
          body += `${update.migrationInstructions}\n\n`;
        }
      });
    }

    await this.createPullRequest({
      title,
      body,
      branch: branchName,
    });
  }

  private getCurrentBranch(): string {
    return execSync("git branch --show-current").toString().trim();
  }

  private createAndCheckoutBranch(branch: string): void {
    try {
      // Check if branch exists
      const branches = execSync("git branch").toString();

      if (branches.includes(branch)) {
        execSync(`git checkout ${branch}`, { stdio: "inherit" });
      } else {
        execSync(`git checkout -b ${branch}`, { stdio: "inherit" });
      }
    } catch (error) {
      logger.error(
        `Error creating/checking out branch ${branch}: ${
          (error as Error).message
        }`
      );
      throw error;
    }
  }

  private hasChangesToCommit(): boolean {
    const status = execSync("git status --porcelain").toString();
    return status.trim().length > 0;
  }
}

export async function createPullRequest(
  updates: DependencyUpdate[]
): Promise<void> {
  try {
    const token = process.env.GITHUB_TOKEN;

    if (!token) {
      logger.error("GITHUB_TOKEN environment variable is not set");
      return;
    }

    // Get repository info from git remote or environment variables
    let repoOwner, repoName;

    try {
      const remoteUrl = execSync("git remote get-url origin").toString().trim();
      const match = remoteUrl.match(
        /github\.com[/:]([^/]+)\/([^/\.]+)(?:\.git)?$/
      );

      if (match) {
        [, repoOwner, repoName] = match;
      }
    } catch (error) {
      // Fallback to environment variables
      repoOwner = process.env.REPO_OWNER;
      repoName = process.env.REPO_NAME;
    }

    if (!repoOwner || !repoName) {
      logger.error("Could not determine repository owner and name");
      return;
    }

    const prGenerator = new PRGenerator(token, repoOwner, repoName);
    await prGenerator.generatePRForDependencyUpdate(updates);
  } catch (error) {
    logger.error(`Error creating pull request: ${(error as Error).message}`);
  }
}
