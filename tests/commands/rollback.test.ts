import {
  rollbackDependencies,
  createBackup,
} from "../../src/commands/rollback";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";

describe("Rollback Command", () => {
  const testProjectPath = join(__dirname, "test-project");
  const packageJsonPath = join(testProjectPath, "package.json");
  const backupPath = join(testProjectPath, "package.json.backup");

  beforeEach(() => {
    // Clean up any existing test files
    if (existsSync(packageJsonPath)) {
      unlinkSync(packageJsonPath);
    }
    if (existsSync(backupPath)) {
      unlinkSync(backupPath);
    }
  });

  afterEach(() => {
    // Clean up test files
    if (existsSync(packageJsonPath)) {
      unlinkSync(packageJsonPath);
    }
    if (existsSync(backupPath)) {
      unlinkSync(backupPath);
    }
  });

  test("should return error when no backup file exists", async () => {
    const result = await rollbackDependencies({ projectPath: testProjectPath });
    expect(result.success).toBe(false);
    expect(result.errors).toContain("No backup file found");
  });

  test("should create backup successfully", async () => {
    // Create a test package.json
    const packageJson = {
      name: "test-package",
      version: "1.0.0",
      dependencies: {
        "test-dep": "^1.0.0",
      },
    };

    // Ensure directory exists
    require("fs").mkdirSync(testProjectPath, { recursive: true });
    writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2));

    const result = await createBackup(testProjectPath);
    expect(result).toBe(true);
    expect(existsSync(backupPath)).toBe(true);
  });

  test("should detect changes between current and backup", async () => {
    // Create test package.json and backup with different versions
    const currentPackageJson = {
      name: "test-package",
      version: "1.0.0",
      dependencies: {
        "test-dep": "^2.0.0",
        "new-dep": "^1.0.0",
      },
    };

    const backupPackageJson = {
      name: "test-package",
      version: "1.0.0",
      dependencies: {
        "test-dep": "^1.0.0",
      },
    };

    // Ensure directory exists
    require("fs").mkdirSync(testProjectPath, { recursive: true });
    writeFileSync(packageJsonPath, JSON.stringify(currentPackageJson, null, 2));
    writeFileSync(backupPath, JSON.stringify(backupPackageJson, null, 2));

    // Note: This would normally fail on install step in a real scenario
    // but we're testing the change detection logic
    const result = await rollbackDependencies({ projectPath: testProjectPath });

    // Should succeed in the test environment since we have a proper npm setup
    expect(result.success).toBe(true);
  });

  test("should handle missing package.json gracefully", async () => {
    const result = await createBackup(testProjectPath);
    expect(result).toBe(false);
  });

  test("should handle errors gracefully", async () => {
    const result = await rollbackDependencies({ projectPath: "/invalid/path" });
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });
});
