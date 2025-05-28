import { exec } from "child_process";
import { promisify } from "util";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { logger } from "./logger";
import {
  PackageManagerError,
  NetworkError,
  wrapError,
  withRetry,
} from "./errors";

const execPromise = promisify(exec);

interface ExecError extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: number;
}

export interface PackageManagerInterface {
  install(packageName: string, version?: string): Promise<void>;
  uninstall(packageName: string): Promise<void>;
  checkOutdated(): Promise<string>;
  getDependencies(projectPath: string): Promise<Record<string, string>>;
  updateDependency(
    projectPath: string,
    packageName: string,
    version: string
  ): Promise<void>;
  audit(): Promise<any>;
  getInstalledVersion(
    projectPath: string,
    packageName: string
  ): Promise<string | null>;
}

abstract class BasePackageManager implements PackageManagerInterface {
  protected abstract getInstallCommand(
    packageName: string,
    version?: string
  ): string;
  protected abstract getUninstallCommand(packageName: string): string;
  protected abstract getOutdatedCommand(): string;
  protected abstract getUpdateCommand(
    packageName: string,
    version: string
  ): string;
  protected abstract getAuditCommand(): string;

  async install(packageName: string, version?: string): Promise<void> {
    const command = this.getInstallCommand(packageName, version);
    try {
      await withRetry(() => this.runCommand(command), 2);
    } catch (error) {
      throw new PackageManagerError(
        `Failed to install ${packageName}${version ? `@${version}` : ""}`,
        this.constructor.name,
        error as Error
      );
    }
  }

  async uninstall(packageName: string): Promise<void> {
    const command = this.getUninstallCommand(packageName);
    try {
      await this.runCommand(command);
    } catch (error) {
      throw new PackageManagerError(
        `Failed to uninstall ${packageName}`,
        this.constructor.name,
        error as Error
      );
    }
  }

  async checkOutdated(): Promise<string> {
    try {
      const { stdout } = await withRetry(
        () => this.runCommand(this.getOutdatedCommand()),
        2
      );
      return stdout;
    } catch (error) {
      throw new PackageManagerError(
        "Failed to check for outdated packages",
        this.constructor.name,
        error as Error
      );
    }
  }

  async getDependencies(projectPath: string): Promise<Record<string, string>> {
    const packageJsonPath = join(projectPath, "package.json");
    if (!existsSync(packageJsonPath)) {
      throw new PackageManagerError(
        `package.json not found at ${packageJsonPath}`,
        this.constructor.name
      );
    }

    try {
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      return {
        ...(packageJson.dependencies || {}),
        ...(packageJson.devDependencies || {}),
      };
    } catch (error) {
      throw new PackageManagerError(
        `Failed to parse package.json at ${packageJsonPath}`,
        this.constructor.name,
        error as Error
      );
    }
  }

  async updateDependency(
    projectPath: string,
    packageName: string,
    version: string
  ): Promise<void> {
    const command = this.getUpdateCommand(packageName, version);
    try {
      await withRetry(() => this.runCommand(command, { cwd: projectPath }), 2);
    } catch (error) {
      throw new PackageManagerError(
        `Failed to update ${packageName} to ${version}`,
        this.constructor.name,
        error as Error
      );
    }
  }

  async audit(): Promise<any> {
    try {
      const { stdout } = await withRetry(
        () => this.runCommand(this.getAuditCommand()),
        2
      );
      return JSON.parse(stdout);
    } catch (error: unknown) {
      if (error instanceof Error && error.message.includes("Command failed")) {
        const execError = error as ExecError;
        if (execError.stdout) {
          try {
            return JSON.parse(
              typeof execError.stdout === "string"
                ? execError.stdout
                : execError.stdout.toString()
            );
          } catch (parseError) {
            throw new PackageManagerError(
              "Failed to parse audit results",
              this.constructor.name,
              parseError as Error
            );
          }
        }
      }
      throw new PackageManagerError(
        "Failed to run security audit",
        this.constructor.name,
        error as Error
      );
    }
  }

  async getInstalledVersion(
    projectPath: string,
    packageName: string
  ): Promise<string | null> {
    try {
      const packageJsonPath = join(
        projectPath,
        "node_modules",
        packageName,
        "package.json"
      );

      if (!existsSync(packageJsonPath)) {
        return null;
      }

      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      return packageJson.version;
    } catch (error) {
      return null;
    }
  }

  protected async runCommand(
    command: string,
    options: any = {}
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execPromise(command, options);
      const stdoutStr = typeof stdout === "string" ? stdout : stdout.toString();
      const stderrStr = typeof stderr === "string" ? stderr : stderr.toString();

      if (stderrStr && !this.isWarningOnly(stderrStr)) {
        throw new Error(stderrStr);
      }

      return { stdout: stdoutStr, stderr: stderrStr };
    } catch (error: unknown) {
      if (error instanceof Error) {
        const execError = error as ExecError;

        // Check for network-related errors
        if (
          execError.message.includes("network") ||
          execError.message.includes("timeout") ||
          execError.message.includes("ENOTFOUND")
        ) {
          throw new NetworkError(
            `Network error executing "${command}"`,
            execError
          );
        }

        if (execError.stdout) {
          const stdoutStr =
            typeof execError.stdout === "string"
              ? execError.stdout
              : execError.stdout.toString();
          const stderrStr = execError.stderr
            ? typeof execError.stderr === "string"
              ? execError.stderr
              : execError.stderr.toString()
            : "";

          return { stdout: stdoutStr, stderr: stderrStr };
        }
        throw wrapError(execError, `Error executing command "${command}"`);
      }
      throw new Error(`Error executing command "${command}": Unknown error`);
    }
  }

  protected abstract isWarningOnly(stderr: string): boolean;
}

class NpmPackageManager extends BasePackageManager {
  protected getInstallCommand(packageName: string, version?: string): string {
    return `npm install ${packageName}${version ? `@${version}` : ""}`;
  }

  protected getUninstallCommand(packageName: string): string {
    return `npm uninstall ${packageName}`;
  }

  protected getOutdatedCommand(): string {
    return "npm outdated --json";
  }

  protected getUpdateCommand(packageName: string, version: string): string {
    return `npm install ${packageName}@${version} --save-exact`;
  }

  protected getAuditCommand(): string {
    return "npm audit --json";
  }

  protected isWarningOnly(stderr: string): boolean {
    return stderr.includes("npm WARN");
  }
}

class YarnPackageManager extends BasePackageManager {
  protected getInstallCommand(packageName: string, version?: string): string {
    return `yarn add ${packageName}${version ? `@${version}` : ""}`;
  }

  protected getUninstallCommand(packageName: string): string {
    return `yarn remove ${packageName}`;
  }

  protected getOutdatedCommand(): string {
    return "yarn outdated --json";
  }

  protected getUpdateCommand(packageName: string, version: string): string {
    return `yarn add ${packageName}@${version} --exact`;
  }

  protected getAuditCommand(): string {
    return "yarn audit --json";
  }

  protected isWarningOnly(stderr: string): boolean {
    return stderr.includes("warning");
  }
}

class PnpmPackageManager extends BasePackageManager {
  protected getInstallCommand(packageName: string, version?: string): string {
    return `pnpm add ${packageName}${version ? `@${version}` : ""}`;
  }

  protected getUninstallCommand(packageName: string): string {
    return `pnpm remove ${packageName}`;
  }

  protected getOutdatedCommand(): string {
    return "pnpm outdated --format json";
  }

  protected getUpdateCommand(packageName: string, version: string): string {
    return `pnpm add ${packageName}@${version} --save-exact`;
  }

  protected getAuditCommand(): string {
    return "pnpm audit --json";
  }

  protected isWarningOnly(stderr: string): boolean {
    return stderr.includes("WARN");
  }
}

export class PackageManagerDetector {
  static detect(projectPath: string): PackageManagerInterface {
    // Check for lock files to determine package manager
    const pnpmLock = join(projectPath, "pnpm-lock.yaml");
    const yarnLock = join(projectPath, "yarn.lock");
    const npmLock = join(projectPath, "package-lock.json");

    if (existsSync(pnpmLock)) {
      logger.info("Detected pnpm package manager");
      return new PnpmPackageManager();
    }

    if (existsSync(yarnLock)) {
      logger.info("Detected yarn package manager");
      return new YarnPackageManager();
    }

    if (existsSync(npmLock)) {
      logger.info("Detected npm package manager");
      return new NpmPackageManager();
    }

    // Default to npm if no lock file is found
    logger.info("No lock file detected, defaulting to npm package manager");
    return new NpmPackageManager();
  }

  static create(packageManager: string): PackageManagerInterface {
    switch (packageManager.toLowerCase()) {
      case "npm":
        return new NpmPackageManager();
      case "yarn":
        return new YarnPackageManager();
      case "pnpm":
        return new PnpmPackageManager();
      default:
        throw new Error(`Unsupported package manager: ${packageManager}`);
    }
  }
}
