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

  test("should return error when current package.json not found", async () => {
    // Create backup but no current package.json
    const backupPackageJson = {
      name: "test-package",
      version: "1.0.0",
      dependencies: {
        "test-dep": "^1.0.0",
      },
    };

    // Ensure directory exists
    require("fs").mkdirSync(testProjectPath, { recursive: true });
    writeFileSync(backupPath, JSON.stringify(backupPackageJson, null, 2));

    const result = await rollbackDependencies({ projectPath: testProjectPath });
    expect(result.success).toBe(false);
    expect(result.errors).toContain("Current package.json not found");
  });

  test("should return success when no changes detected", async () => {
    // Create identical package.json and backup
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
    writeFileSync(backupPath, JSON.stringify(packageJson, null, 2));

    const result = await rollbackDependencies({ projectPath: testProjectPath });
    expect(result.success).toBe(true);
    expect(result.rolledBack).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("should handle install failure and restore original package.json", async () => {
    // Create test package.json and backup with different versions
    const currentPackageJson = {
      name: "test-package",
      version: "1.0.0",
      dependencies: {
        "invalid-nonexistent-package-12345": "^999.0.0",
      },
    };

    const backupPackageJson = {
      name: "test-package",
      version: "1.0.0",
      dependencies: {
        "invalid-nonexistent-package-12345": "^888.0.0",
      },
    };

    // Ensure directory exists
    require("fs").mkdirSync(testProjectPath, { recursive: true });
    writeFileSync(packageJsonPath, JSON.stringify(currentPackageJson, null, 2));
    writeFileSync(backupPath, JSON.stringify(backupPackageJson, null, 2));

    const result = await rollbackDependencies({ projectPath: testProjectPath });

    // Should fail due to invalid package but handle it gracefully
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("Install failed:");

    // Should have restored the original package.json
    const restoredContent = JSON.parse(
      require("fs").readFileSync(packageJsonPath, "utf8")
    );
    expect(restoredContent).toEqual(currentPackageJson);
  });

  test("should preserve cleanupBackup setting when disabled", async () => {
    // Create test package.json and backup with different versions
    const currentPackageJson = {
      name: "test-package",
      version: "1.0.0",
      dependencies: {
        "test-dep": "^2.0.0",
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

    const result = await rollbackDependencies({
      projectPath: testProjectPath,
      cleanupBackup: false,
    });

    expect(result.success).toBe(true);
    // Backup should still exist when cleanupBackup is false
    expect(existsSync(backupPath)).toBe(true);
  });

  test("should handle JSON parsing errors gracefully", async () => {
    // Create invalid JSON files
    require("fs").mkdirSync(testProjectPath, { recursive: true });
    writeFileSync(packageJsonPath, "invalid json content");
    writeFileSync(backupPath, "invalid json content");

    const result = await rollbackDependencies({ projectPath: testProjectPath });
    expect(result.success).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  test("should handle backup creation errors", async () => {
    // Test createBackup with invalid project path
    const result = await createBackup("/invalid/readonly/path");
    expect(result).toBe(false);
  });

  test("should handle backup creation file write errors", async () => {
    // Create a directory structure where we can't write backup files
    const readOnlyPath = join(testProjectPath, "readonly");
    const packageJsonPath = join(readOnlyPath, "package.json");

    require("fs").mkdirSync(readOnlyPath, { recursive: true });
    writeFileSync(packageJsonPath, JSON.stringify({ name: "test" }, null, 2));

    // Make directory read-only to trigger write error
    if (process.platform !== "win32") {
      require("fs").chmodSync(readOnlyPath, 0o444);
    }

    const result = await createBackup(readOnlyPath);
    expect(result).toBe(false);

    // Clean up: restore write permissions
    if (process.platform !== "win32") {
      require("fs").chmodSync(readOnlyPath, 0o755);
    }
  });

  test("should detect removed dependencies correctly", async () => {
    // Create test package.json and backup where backup has more dependencies
    const currentPackageJson = {
      name: "test-package",
      version: "1.0.0",
      dependencies: {},
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

    const result = await rollbackDependencies({ projectPath: testProjectPath });
    expect(result.success).toBe(true);
    expect(result.rolledBack).toContain("test-dep");
  });

  test("should handle mixed dependency types (dependencies and devDependencies)", async () => {
    // Create test package.json and backup with mixed dependency types
    const currentPackageJson = {
      name: "test-package",
      version: "1.0.0",
      dependencies: {
        colorette: "^2.0.0",
      },
      devDependencies: {
        jest: "^29.0.0",
      },
    };

    const backupPackageJson = {
      name: "test-package",
      version: "1.0.0",
      dependencies: {
        colorette: "^1.0.0",
      },
      devDependencies: {
        jest: "^28.0.0",
      },
    };

    // Ensure directory exists
    require("fs").mkdirSync(testProjectPath, { recursive: true });
    writeFileSync(packageJsonPath, JSON.stringify(currentPackageJson, null, 2));
    writeFileSync(backupPath, JSON.stringify(backupPackageJson, null, 2));

    const result = await rollbackDependencies({ projectPath: testProjectPath });
    expect(result.success).toBe(true);
    expect(result.rolledBack).toContain("colorette");
    expect(result.rolledBack).toContain("jest");
  });
});
