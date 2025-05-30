import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { logger } from "./logger";

export interface AuthConfig {
  token?: string;
  provider?: "vscode" | "env" | "config" | "manual";
}

/**
 * Authentication service that handles GitHub token retrieval from multiple sources
 */
export class AuthService {
  private static instance: AuthService;
  private cachedAuth: AuthConfig | null = null;

  private constructor() {}

  static getInstance(): AuthService {
    if (!AuthService.instance) {
      AuthService.instance = new AuthService();
    }
    return AuthService.instance;
  }

  /**
   * Get GitHub token from various sources in order of priority:
   * 1. Manual token (command line argument)
   * 2. VS Code authentication
   * 3. Environment files (.env, .env.local)
   * 4. System environment variables
   * 5. Git credential helper
   */
  async getGitHubToken(manualToken?: string): Promise<AuthConfig> {
    // Return cached auth if available and no manual token provided
    if (this.cachedAuth && !manualToken) {
      return this.cachedAuth;
    }

    // 1. Manual token (highest priority)
    if (manualToken) {
      logger.info("Using manually provided GitHub token");
      this.cachedAuth = { token: manualToken, provider: "manual" };
      return this.cachedAuth;
    }

    // 2. Try VS Code authentication (if available)
    try {
      const vscodeToken = await this.getVSCodeToken();
      if (vscodeToken) {
        logger.info("Using VS Code GitHub authentication");
        this.cachedAuth = { token: vscodeToken, provider: "vscode" };
        return this.cachedAuth;
      }
    } catch (error) {
      logger.debug("VS Code authentication not available");
    }

    // 3. Check environment files
    const envToken = this.getTokenFromEnvFiles();
    if (envToken) {
      logger.info("Using GitHub token from environment file");
      this.cachedAuth = { token: envToken, provider: "config" };
      return this.cachedAuth;
    }

    // 4. Check system environment variables
    const systemToken = process.env.GITHUB_TOKEN;
    if (systemToken) {
      logger.info("Using GitHub token from system environment");
      this.cachedAuth = { token: systemToken, provider: "env" };
      return this.cachedAuth;
    }

    // 5. Try git credential helper
    try {
      const gitToken = await this.getTokenFromGitCredentials();
      if (gitToken) {
        logger.info("Using GitHub token from git credentials");
        this.cachedAuth = { token: gitToken, provider: "env" };
        return this.cachedAuth;
      }
    } catch (error) {
      logger.debug("Could not retrieve token from git credentials");
    }

    return { provider: "manual" };
  }

  /**
   * Get token from VS Code authentication API
   */
  private async getVSCodeToken(): Promise<string | null> {
    try {
      // Check if we're running in VS Code environment
      if (
        !process.env.VSCODE_PID &&
        !process.env.TERM_PROGRAM?.includes("vscode")
      ) {
        return null;
      }

      // Try to use VS Code's authentication API
      // This requires the extension context, but for CLI tools we need a different approach

      // Check if VS Code has stored credentials we can access
      const vscodeConfigPaths = this.getVSCodeConfigPaths();

      for (const configPath of vscodeConfigPaths) {
        try {
          if (existsSync(configPath)) {
            const config = JSON.parse(readFileSync(configPath, "utf8"));
            // Look for GitHub authentication settings
            if (config["github.gitAuthentication"] === true) {
              // Try to extract token from VS Code's secure storage
              const token = await this.extractVSCodeStoredToken();
              if (token) return token;
            }
          }
        } catch (error) {
          // Continue to next config path
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get possible VS Code configuration paths
   */
  private getVSCodeConfigPaths(): string[] {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    const platform = process.platform;

    const paths: string[] = [];

    if (platform === "darwin") {
      paths.push(
        join(home, "Library/Application Support/Code/User/settings.json")
      );
      paths.push(
        join(
          home,
          "Library/Application Support/Code - Insiders/User/settings.json"
        )
      );
    } else if (platform === "win32") {
      paths.push(join(home, "AppData/Roaming/Code/User/settings.json"));
      paths.push(
        join(home, "AppData/Roaming/Code - Insiders/User/settings.json")
      );
    } else {
      paths.push(join(home, ".config/Code/User/settings.json"));
      paths.push(join(home, ".config/Code - Insiders/User/settings.json"));
    }

    return paths;
  }

  /**
   * Extract token from VS Code's stored credentials
   */
  private async extractVSCodeStoredToken(): Promise<string | null> {
    try {
      // This is a simplified approach - in a real VS Code extension,
      // you would use the authentication API directly

      // Try to use git credential helper if VS Code has configured it
      const gitConfigAuth = execSync("git config --get credential.helper", {
        stdio: "pipe",
        encoding: "utf8",
      }).trim();

      if (gitConfigAuth && gitConfigAuth.includes("vscode")) {
        // VS Code is configured as credential helper
        return await this.getTokenFromGitCredentials();
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Get token from environment files (.env, .env.local)
   */
  private getTokenFromEnvFiles(): string | null {
    const envFiles = [".env.local", ".env"];
    const projectRoot = process.cwd();

    for (const envFile of envFiles) {
      const envPath = join(projectRoot, envFile);
      if (existsSync(envPath)) {
        try {
          const content = readFileSync(envPath, "utf8");
          const lines = content.split("\n");

          for (const line of lines) {
            const match = line.match(/^GITHUB_TOKEN\s*=\s*(.+)$/);
            if (match) {
              // Remove quotes if present
              let token = match[1].trim();
              if (
                (token.startsWith('"') && token.endsWith('"')) ||
                (token.startsWith("'") && token.endsWith("'"))
              ) {
                token = token.slice(1, -1);
              }
              return token;
            }
          }
        } catch (error) {
          logger.debug(
            `Could not read ${envFile}: ${(error as Error).message}`
          );
        }
      }
    }

    return null;
  }

  /**
   * Try to get token from git credential helper
   */
  private async getTokenFromGitCredentials(): Promise<string | null> {
    try {
      // Check if git credential helper is configured for GitHub
      const credentialHelper = execSync("git config --get credential.helper", {
        stdio: "pipe",
        encoding: "utf8",
      }).trim();

      if (!credentialHelper) {
        return null;
      }

      // Try to get credentials for github.com
      const credentialInput = "protocol=https\nhost=github.com\n\n";
      const credentials = execSync("git credential fill", {
        input: credentialInput,
        stdio: "pipe",
        encoding: "utf8",
      });

      // Parse the credentials output
      const lines = credentials.split("\n");
      for (const line of lines) {
        if (line.startsWith("password=")) {
          return line.substring("password=".length);
        }
      }

      return null;
    } catch (error) {
      return null;
    }
  }

  /**
   * Clear cached authentication
   */
  clearCache(): void {
    this.cachedAuth = null;
  }

  /**
   * Validate if a token is valid by making a test API call
   */
  async validateToken(token: string): Promise<boolean> {
    try {
      const { Octokit } = await import("@octokit/rest");
      const octokit = new Octokit({ auth: token });

      await octokit.request("/user");
      return true;
    } catch (error) {
      return false;
    }
  }

  /**
   * Interactive setup for when no token is found
   */
  async interactiveSetup(): Promise<string | null> {
    try {
      const { input, confirm } = await import("@inquirer/prompts");

      logger.info("\n🔑 GitHub Authentication Setup");
      logger.info("No GitHub token found. Let's set one up!");

      const setupChoice = await confirm({
        message: "Would you like to enter a GitHub token manually?",
        default: true,
      });

      if (!setupChoice) {
        logger.info("\nYou can set up authentication later by:");
        logger.info("1. Creating a .env file with GITHUB_TOKEN=your_token");
        logger.info("2. Setting the GITHUB_TOKEN environment variable");
        logger.info("3. Using --token flag with the command");
        logger.info("4. Enabling GitHub authentication in VS Code");
        return null;
      }

      const token = await input({
        message: "Enter your GitHub Personal Access Token:",
        validate: (input: string) => {
          if (!input.trim()) {
            return "Token cannot be empty";
          }
          if (!input.startsWith("ghp_") && !input.startsWith("github_pat_")) {
            return "Token should start with 'ghp_' or 'github_pat_'";
          }
          return true;
        },
      });

      // Validate the token
      const isValid = await this.validateToken(token);
      if (!isValid) {
        logger.error(
          "Invalid token provided. Please check your token and try again."
        );
        return null;
      }

      // Ask if they want to save it to .env file
      const saveToEnv = await confirm({
        message:
          "Would you like to save this token to .env file for future use?",
        default: true,
      });

      if (saveToEnv) {
        await this.saveTokenToEnvFile(token);
      }

      return token;
    } catch (error) {
      logger.error(`Interactive setup failed: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Save token to .env file
   */
  private async saveTokenToEnvFile(token: string): Promise<void> {
    try {
      const { writeFileSync, appendFileSync } = await import("fs");
      const envPath = join(process.cwd(), ".env");

      if (existsSync(envPath)) {
        // Append to existing .env file
        appendFileSync(envPath, `\nGITHUB_TOKEN=${token}\n`);
      } else {
        // Create new .env file
        writeFileSync(envPath, `GITHUB_TOKEN=${token}\n`);
      }

      logger.info(`Token saved to ${envPath}`);
      logger.info("Make sure to add .env to your .gitignore file!");
    } catch (error) {
      logger.error(
        `Failed to save token to .env file: ${(error as Error).message}`
      );
    }
  }
}

/**
 * Convenience function to get GitHub token
 */
export async function getGitHubToken(
  manualToken?: string
): Promise<string | null> {
  const authService = AuthService.getInstance();
  const auth = await authService.getGitHubToken(manualToken);

  if (!auth.token) {
    logger.warn("No GitHub token found. GitHub features will be disabled.");
    logger.info("To enable GitHub features:");
    logger.info("• Use --token flag to provide a token");
    logger.info("• Set GITHUB_TOKEN environment variable");
    logger.info("• Create a .env file with GITHUB_TOKEN=your_token");
    logger.info("• Enable GitHub authentication in VS Code");

    // Offer interactive setup
    try {
      const { confirm } = await import("@inquirer/prompts");
      const setupNow = await confirm({
        message: "Would you like to set up GitHub authentication now?",
        default: false,
      });

      if (setupNow) {
        return await authService.interactiveSetup();
      }
    } catch (error) {
      // Non-interactive environment, just return null
    }
  }

  return auth.token || null;
}
