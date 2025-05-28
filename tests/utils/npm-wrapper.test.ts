import { exec } from "child_process";
import { promisify } from "util";

const execAsync = promisify(exec);

describe("NPM Wrapper Utility", () => {
  test("should list installed packages", async () => {
    const { stdout, stderr } = await execAsync(`npm list --depth=0`);

    expect(stderr).toBe("");
    expect(stdout).toContain("always-up-to-date"); // Our package should be listed
  });

  test("should check for outdated packages", async () => {
    try {
      const { stdout, stderr } = await execAsync(`npm outdated`);
      // npm outdated returns exit code 1 when packages are outdated
      // and exit code 0 when all packages are up to date
      expect(typeof stdout).toBe("string");
    } catch (error: any) {
      // This is expected when there are outdated packages (exit code 1)
      expect(error.code).toBe(1);
      expect(typeof error.stdout).toBe("string");
    }
  });

  test("should show package info", async () => {
    const { stdout, stderr } = await execAsync(`npm show semver version`);

    expect(stderr).toBe("");
    expect(stdout).toMatch(/^\d+\.\d+\.\d+/); // Should return a version number
  });
});
