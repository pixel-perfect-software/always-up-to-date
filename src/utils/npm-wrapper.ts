import { exec } from "child_process";
import { promisify } from "util";
import { readFileSync } from "fs";
import { join } from "path";

const execPromise = promisify(exec);

// Define a type for command execution errors
interface ExecError extends Error {
  stdout?: string | Buffer;
  stderr?: string | Buffer;
  code?: number;
}

/**
 * A wrapper for npm commands to facilitate dependency management.
 */
class NpmWrapper {
  /**
   * Installs a package with the specified version.
   * @param packageName - The name of the package to install.
   * @param version - The version of the package to install. If not specified, installs the latest version.
   */
  async install(packageName: string, version?: string): Promise<void> {
    const command = `npm install ${packageName}${version ? `@${version}` : ""}`;
    await this.runCommand(command);
  }

  /**
   * Uninstalls a package.
   * @param packageName - The name of the package to uninstall.
   */
  async uninstall(packageName: string): Promise<void> {
    const command = `npm uninstall ${packageName}`;
    await this.runCommand(command);
  }

  /**
   * Checks for outdated packages.
   * @returns A promise that resolves to the list of outdated packages.
   */
  async checkOutdated(): Promise<string> {
    const { stdout } = await this.runCommand("npm outdated --json");
    return stdout;
  }

  /**
   * Gets all dependencies from package.json
   * @param projectPath - The path to the project directory
   * @returns A promise that resolves to an object with dependencies
   */
  async getDependencies(projectPath: string): Promise<Record<string, string>> {
    const packageJsonPath = join(projectPath, "package.json");
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));

    return {
      ...(packageJson.dependencies || {}),
      ...(packageJson.devDependencies || {}),
    };
  }

  /**
   * Updates a dependency to a new version
   * @param projectPath - The path to the project directory
   * @param packageName - The name of the package to update
   * @param version - The new version to update to
   * @returns A promise that resolves when the update is complete
   */
  async updateDependency(
    projectPath: string,
    packageName: string,
    version: string
  ): Promise<void> {
    const command = `npm install ${packageName}@${version} --save-exact`;
    await this.runCommand(command, { cwd: projectPath });
  }

  /**
   * Runs npm audit to check for vulnerabilities
   * @returns A promise that resolves to the audit result
   */
  async audit(): Promise<any> {
    try {
      const { stdout } = await this.runCommand("npm audit --json");
      return JSON.parse(stdout);
    } catch (error: unknown) {
      // npm audit exits with code 1 if vulnerabilities are found
      if (error instanceof Error && error.message.includes("Command failed")) {
        const execError = error as ExecError;
        if (execError.stdout) {
          return JSON.parse(
            typeof execError.stdout === "string"
              ? execError.stdout
              : execError.stdout.toString()
          );
        }
      }
      throw error;
    }
  }

  /**
   * Gets the actually installed version of a package from node_modules
   * @param projectPath - The path to the project directory
   * @param packageName - The name of the package
   * @returns The installed version or null if not installed
   */
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
      const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
      return packageJson.version;
    } catch (error) {
      // Package might not be installed or another error occurred
      return null;
    }
  }

  /**
   * Runs a command using npm.
   * @param command - The npm command to run.
   * @param options - Options for the command execution
   * @returns The output of the command.
   */
  private async runCommand(
    command: string,
    options: any = {}
  ): Promise<{ stdout: string; stderr: string }> {
    try {
      const { stdout, stderr } = await execPromise(command, options);
      // Convert Buffer to string if needed
      const stdoutStr = typeof stdout === "string" ? stdout : stdout.toString();
      const stderrStr = typeof stderr === "string" ? stderr : stderr.toString();

      if (stderrStr && !stderrStr.includes("npm WARN")) {
        throw new Error(stderrStr);
      }

      return { stdout: stdoutStr, stderr: stderrStr };
    } catch (error: unknown) {
      if (error instanceof Error) {
        const execError = error as ExecError;
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
        throw new Error(
          `Error executing command "${command}": ${execError.message}`
        );
      }
      throw new Error(`Error executing command "${command}": Unknown error`);
    }
  }
}

export default new NpmWrapper();
