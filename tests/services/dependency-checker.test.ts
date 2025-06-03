import {
  checkDependencies,
  checkForUpdates,
  updateDependencies,
  DependencyChecker,
} from "../../src/services/dependency-checker";
import { execSync } from "child_process";
import { PackageManagerDetector } from "../../src/utils/package-manager";
import { ConfigManager } from "../../src/utils/config";
import { MigrationAdvisor } from "../../src/services/migration-advisor";
import { withRetry, DependencyError } from "../../src/utils/errors";

// Mock all dependencies
jest.mock("child_process");
jest.mock("../../src/utils/package-manager");
jest.mock("../../src/utils/config");
jest.mock("../../src/services/migration-advisor");
jest.mock("../../src/utils/errors");
jest.mock("../../src/utils/workspace-manager");
jest.mock("../../src/utils/logger", () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockWithRetry = withRetry as jest.MockedFunction<typeof withRetry>;
const mockPackageManagerDetector = PackageManagerDetector as jest.Mocked<
  typeof PackageManagerDetector
>;
const mockConfigManager = ConfigManager as jest.MockedClass<
  typeof ConfigManager
>;
const mockMigrationAdvisor = MigrationAdvisor as jest.MockedClass<
  typeof MigrationAdvisor
>;

// Import and mock WorkspaceManager
import { WorkspaceManager } from "../../src/utils/workspace-manager";
const mockWorkspaceManager = WorkspaceManager as jest.Mocked<
  typeof WorkspaceManager
>;

describe("Dependency Checker Service", () => {
  let mockPackageManager: any;
  let mockConfig: any;
  let mockMigrationAdvisorInstance: any;

  beforeEach(() => {
    jest.clearAllMocks();

    // Setup package manager mock
    mockPackageManager = {
      getDependencies: jest.fn(),
      getInstalledVersion: jest.fn(),
      updateDependency: jest.fn(),
    };
    mockPackageManagerDetector.detect.mockReturnValue(mockPackageManager);

    // Setup config manager mock
    mockConfig = {
      shouldIgnorePackage: jest.fn().mockReturnValue(false),
      shouldIgnoreVersion: jest.fn().mockReturnValue(false),
      getUpdateStrategyForPackage: jest.fn().mockReturnValue("major"),
      shouldAllowMajorUpdate: jest.fn().mockReturnValue(true),
      getConfig: jest.fn().mockReturnValue({
        retryAttempts: 3,
        retryDelay: 1000,
      }),
    };
    mockConfigManager.mockImplementation(() => mockConfig);

    // Setup migration advisor mock
    mockMigrationAdvisorInstance = {
      getMigrationInstructions: jest
        .fn()
        .mockResolvedValue("Migration instructions"),
    };
    mockMigrationAdvisor.mockImplementation(() => mockMigrationAdvisorInstance);

    // Setup withRetry mock to just execute the function
    mockWithRetry.mockImplementation(async (fn) => await fn());

    // Setup WorkspaceManager mock to return single package workspace
    mockWorkspaceManager.detect.mockResolvedValue({
      isMonorepo: false,
      rootPath: "/test/project",
      packages: [
        {
          name: "test-package",
          path: "/test/project",
          packageJson: {},
          dependencies: {},
          devDependencies: {},
          isRoot: true,
        },
      ],
      workspacePatterns: [],
      packageManager: "npm",
    });
  });

  describe("checkDependencies helper function", () => {
    test("should identify updatable dependencies", async () => {
      // Mock npm show responses
      mockExecSync
        .mockReturnValueOnce(Buffer.from("1.1.0")) // example-package latest version
        .mockReturnValueOnce(Buffer.from("2.2.0")); // another-package latest version

      const dependencies = {
        "example-package": "1.0.0",
        "another-package": "2.1.0",
      };

      const updates = await checkDependencies(dependencies);

      expect(updates).toEqual([
        {
          name: "example-package",
          currentVersion: "1.0.0",
          newVersion: "1.1.0",
          hasBreakingChanges: false,
        },
        {
          name: "another-package",
          currentVersion: "2.1.0",
          newVersion: "2.2.0",
          hasBreakingChanges: false,
        },
      ]);

      expect(mockExecSync).toHaveBeenCalledWith(
        "npm show example-package version",
        { stdio: "pipe" }
      );
      expect(mockExecSync).toHaveBeenCalledWith(
        "npm show another-package version",
        { stdio: "pipe" }
      );
    });

    test("should handle breaking changes", async () => {
      // Mock npm show response for major version bump
      mockExecSync.mockReturnValueOnce(Buffer.from("2.0.0"));

      const dependencies = {
        "breaking-package": "1.0.0",
      };

      const updates = await checkDependencies(dependencies);

      expect(updates).toEqual([
        {
          name: "breaking-package",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: true,
        },
      ]);
    });

    test("should return an empty array for up-to-date dependencies", async () => {
      // Mock npm show response showing same version
      mockExecSync.mockReturnValueOnce(Buffer.from("2.2.0"));

      const dependencies = {
        "up-to-date-package": "2.2.0",
      };

      const updates = await checkDependencies(dependencies);

      expect(updates).toEqual([]);
    });

    test("should handle npm errors gracefully", async () => {
      // Mock npm show to throw error (package not found)
      mockExecSync.mockImplementation(() => {
        throw new Error("Package not found");
      });

      const dependencies = {
        "nonexistent-package": "1.0.0",
      };

      const updates = await checkDependencies(dependencies);

      expect(updates).toEqual([]);

      const { logger } = require("../../src/utils/logger");
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining("Failed to check nonexistent-package")
      );
    });
  });

  describe("DependencyChecker class", () => {
    let dependencyChecker: DependencyChecker;

    beforeEach(() => {
      dependencyChecker = new DependencyChecker("/test/project");
    });

    describe("constructor", () => {
      test("should initialize with project path", () => {
        expect(mockPackageManagerDetector.detect).toHaveBeenCalledWith(
          "/test/project"
        );
        expect(mockConfigManager).toHaveBeenCalledWith("/test/project");
        expect(mockMigrationAdvisor).toHaveBeenCalled();
      });

      test("should use current working directory if no path provided", () => {
        jest.clearAllMocks();
        new DependencyChecker();
        expect(mockPackageManagerDetector.detect).toHaveBeenCalledWith(
          process.cwd()
        );
      });
    });

    describe("checkForUpdates", () => {
      test("should return updatable dependencies", async () => {
        mockPackageManager.getDependencies.mockResolvedValue({
          "test-package": "1.0.0",
        });
        mockPackageManager.getInstalledVersion.mockResolvedValue("1.0.0");
        mockWithRetry.mockResolvedValue("1.1.0");

        const result = await dependencyChecker.checkForUpdates();

        expect(result.updatable).toHaveLength(1);
        expect(result.updatable[0]).toEqual({
          name: "test-package",
          currentVersion: "1.0.0",
          installedVersion: "1.0.0",
          newVersion: "1.1.0",
          hasBreakingChanges: false,
        });
        expect(result.breakingChanges).toHaveLength(0);
      });

      test("should return breaking changes for major version updates", async () => {
        mockPackageManager.getDependencies.mockResolvedValue({
          "breaking-package": "1.0.0",
        });
        mockPackageManager.getInstalledVersion.mockResolvedValue("1.0.0");
        mockWithRetry.mockResolvedValue("2.0.0");

        const result = await dependencyChecker.checkForUpdates();

        expect(result.updatable).toHaveLength(0);
        expect(result.breakingChanges).toHaveLength(1);
        expect(result.breakingChanges[0]).toEqual({
          name: "breaking-package",
          currentVersion: "1.0.0",
          installedVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: true,
          migrationInstructions: "Migration instructions",
        });
      });

      test("should skip ignored packages", async () => {
        mockPackageManager.getDependencies.mockResolvedValue({
          "ignored-package": "1.0.0",
        });
        mockConfig.shouldIgnorePackage.mockReturnValue(true);

        const result = await dependencyChecker.checkForUpdates();

        expect(result.updatable).toHaveLength(0);
        expect(result.breakingChanges).toHaveLength(0);
        expect(mockConfig.shouldIgnorePackage).toHaveBeenCalledWith(
          "ignored-package"
        );
      });

      test("should skip ignored versions", async () => {
        mockPackageManager.getDependencies.mockResolvedValue({
          "test-package": "1.0.0",
        });
        mockPackageManager.getInstalledVersion.mockResolvedValue("1.0.0");
        mockWithRetry.mockResolvedValue("1.1.0");
        mockConfig.shouldIgnoreVersion.mockReturnValue(true);

        const result = await dependencyChecker.checkForUpdates();

        expect(result.updatable).toHaveLength(0);
        expect(result.breakingChanges).toHaveLength(0);
        expect(mockConfig.shouldIgnoreVersion).toHaveBeenCalledWith(
          "test-package",
          "1.1.0"
        );
      });

      test("should handle update strategy restrictions", async () => {
        mockPackageManager.getDependencies.mockResolvedValue({
          "test-package": "1.0.0",
        });
        mockPackageManager.getInstalledVersion.mockResolvedValue("1.0.0");
        mockWithRetry.mockResolvedValue("1.1.0");
        mockConfig.getUpdateStrategyForPackage.mockReturnValue("patch");

        const result = await dependencyChecker.checkForUpdates();

        expect(result.updatable).toHaveLength(0);
        expect(result.breakingChanges).toHaveLength(0);
      });

      test("should allow updates based on patch strategy", async () => {
        mockPackageManager.getDependencies.mockResolvedValue({
          "test-package": "1.0.0",
        });
        mockPackageManager.getInstalledVersion.mockResolvedValue("1.0.0");
        mockWithRetry.mockResolvedValue("1.0.1");
        mockConfig.getUpdateStrategyForPackage.mockReturnValue("patch");

        const result = await dependencyChecker.checkForUpdates();

        expect(result.updatable).toHaveLength(1);
        expect(result.updatable[0].name).toBe("test-package");
      });

      test("should allow updates based on minor strategy", async () => {
        mockPackageManager.getDependencies.mockResolvedValue({
          "test-package": "1.0.0",
        });
        mockPackageManager.getInstalledVersion.mockResolvedValue("1.0.0");
        mockWithRetry.mockResolvedValue("1.1.0");
        mockConfig.getUpdateStrategyForPackage.mockReturnValue("minor");

        const result = await dependencyChecker.checkForUpdates();

        expect(result.updatable).toHaveLength(1);
        expect(result.updatable[0].name).toBe("test-package");
      });

      test("should block updates when strategy is none", async () => {
        mockPackageManager.getDependencies.mockResolvedValue({
          "test-package": "1.0.0",
        });
        mockPackageManager.getInstalledVersion.mockResolvedValue("1.0.0");
        mockWithRetry.mockResolvedValue("1.1.0");
        mockConfig.getUpdateStrategyForPackage.mockReturnValue("none");

        const result = await dependencyChecker.checkForUpdates();

        expect(result.updatable).toHaveLength(0);
        expect(result.breakingChanges).toHaveLength(0);
      });

      test("should handle major updates blocked by config", async () => {
        mockPackageManager.getDependencies.mockResolvedValue({
          "test-package": "1.0.0",
        });
        mockPackageManager.getInstalledVersion.mockResolvedValue("1.0.0");
        mockWithRetry.mockResolvedValue("2.0.0");
        mockConfig.shouldAllowMajorUpdate.mockReturnValue(false);

        const result = await dependencyChecker.checkForUpdates();

        expect(result.updatable).toHaveLength(0);
        expect(result.breakingChanges).toHaveLength(1);
        expect(result.breakingChanges[0].hasBreakingChanges).toBe(true);
      });

      test("should handle version mismatch between package.json and installed", async () => {
        mockPackageManager.getDependencies.mockResolvedValue({
          "test-package": "1.0.0",
        });
        mockPackageManager.getInstalledVersion.mockResolvedValue("0.9.0");
        mockWithRetry.mockImplementation(async () => "1.1.0");

        const result = await dependencyChecker.checkForUpdates();

        expect(result.updatable).toHaveLength(0);
        expect(result.breakingChanges).toHaveLength(1);
        expect(result.breakingChanges[0]).toEqual({
          name: "test-package",
          currentVersion: "1.0.0",
          installedVersion: "0.9.0",
          newVersion: "1.1.0",
          hasBreakingChanges: true,
          migrationInstructions: "Migration instructions",
        });
      });

      test("should clean version strings with prefixes", async () => {
        mockPackageManager.getDependencies.mockResolvedValue({
          "test-package": "^1.0.0",
        });
        mockPackageManager.getInstalledVersion.mockResolvedValue("~1.0.0");
        mockWithRetry.mockResolvedValue("1.1.0");

        const result = await dependencyChecker.checkForUpdates();

        expect(result.updatable).toHaveLength(1);
        expect(result.updatable[0].currentVersion).toBe("1.0.0");
        expect(result.updatable[0].installedVersion).toBe("1.0.0");
      });

      test("should handle errors gracefully", async () => {
        mockPackageManager.getDependencies.mockRejectedValue(
          new Error("Package manager error")
        );

        const result = await dependencyChecker.checkForUpdates();

        expect(result.updatable).toHaveLength(0);
        expect(result.breakingChanges).toHaveLength(0);

        const { logger } = require("../../src/utils/logger");
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining("Error checking for updates")
        );
      });

      test("should handle getLatestVersion errors", async () => {
        mockPackageManager.getDependencies.mockResolvedValue({
          "test-package": "1.0.0",
        });
        mockWithRetry.mockRejectedValue(new Error("Network error"));

        const result = await dependencyChecker.checkForUpdates();

        expect(result.updatable).toHaveLength(0);
        expect(result.breakingChanges).toHaveLength(0);
      });

      test("should handle migration instruction errors", async () => {
        mockPackageManager.getDependencies.mockResolvedValue({
          "test-package": "1.0.0",
        });
        mockPackageManager.getInstalledVersion.mockResolvedValue("1.0.0");
        mockWithRetry.mockResolvedValue("2.0.0");
        mockMigrationAdvisorInstance.getMigrationInstructions.mockRejectedValue(
          new Error("Migration advisor error")
        );

        const result = await dependencyChecker.checkForUpdates();

        expect(result.breakingChanges).toHaveLength(1);
        expect(result.breakingChanges[0].migrationInstructions).toContain(
          "Unable to fetch migration instructions"
        );

        const { logger } = require("../../src/utils/logger");
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining("Error getting migration instructions")
        );
      });
    });

    describe("updateDependencies", () => {
      test("should update non-breaking dependencies", async () => {
        // Mock checkForUpdates to return updatable dependencies
        jest.spyOn(dependencyChecker, "checkForUpdates").mockResolvedValue({
          updatable: [
            {
              name: "test-package",
              currentVersion: "1.0.0",
              newVersion: "1.1.0",
              hasBreakingChanges: false,
            },
          ],
          breakingChanges: [],
        });

        const result = await dependencyChecker.updateDependencies();

        expect(result).toHaveLength(1);
        expect(result[0].name).toBe("test-package");
        expect(mockPackageManager.updateDependency).toHaveBeenCalledWith(
          "/test/project",
          "test-package",
          "1.1.0"
        );

        const { logger } = require("../../src/utils/logger");
        expect(logger.info).toHaveBeenCalledWith(
          "Updated test-package from 1.0.0 to 1.1.0"
        );
      });

      test("should handle update errors gracefully", async () => {
        jest
          .spyOn(dependencyChecker, "checkForUpdates")
          .mockRejectedValue(new Error("Check for updates error"));

        const result = await dependencyChecker.updateDependencies();

        expect(result).toHaveLength(0);

        const { logger } = require("../../src/utils/logger");
        expect(logger.error).toHaveBeenCalledWith(
          expect.stringContaining("Error updating dependencies")
        );
      });
    });
  });

  describe("helper functions", () => {
    test("checkForUpdates helper should create DependencyChecker and call checkForUpdates", async () => {
      mockPackageManager.getDependencies.mockResolvedValue({});

      await checkForUpdates("/test/path");

      expect(mockPackageManagerDetector.detect).toHaveBeenCalledWith(
        "/test/path"
      );
    });

    test("updateDependencies helper should create DependencyChecker and call updateDependencies", async () => {
      // Mock the checkForUpdates method to avoid calling real implementation
      jest
        .spyOn(DependencyChecker.prototype, "checkForUpdates")
        .mockResolvedValue({
          updatable: [],
          breakingChanges: [],
        });

      await updateDependencies("/test/path");

      expect(mockPackageManagerDetector.detect).toHaveBeenCalledWith(
        "/test/path"
      );
    });
  });

  describe("private methods edge cases", () => {
    let dependencyChecker: DependencyChecker;

    beforeEach(() => {
      dependencyChecker = new DependencyChecker("/test/project");
    });

    test("should handle invalid version strings in canUpdate", async () => {
      mockPackageManager.getDependencies.mockResolvedValue({
        "invalid-package": "invalid-version",
      });
      mockPackageManager.getInstalledVersion.mockResolvedValue(
        "invalid-version"
      );
      mockWithRetry.mockResolvedValue("1.0.0");

      const result = await dependencyChecker.checkForUpdates();

      expect(result.updatable).toHaveLength(0);
      expect(result.breakingChanges).toHaveLength(0);
    });

    test("should handle invalid version strings in hasBreakingChanges", async () => {
      mockPackageManager.getDependencies.mockResolvedValue({
        "test-package": "1.0.0",
      });
      mockPackageManager.getInstalledVersion.mockResolvedValue("1.0.0");
      mockWithRetry.mockResolvedValue("invalid-version");

      const result = await dependencyChecker.checkForUpdates();

      expect(result.updatable).toHaveLength(0);
      expect(result.breakingChanges).toHaveLength(0);
    });

    test("should handle null installed version", async () => {
      mockPackageManager.getDependencies.mockResolvedValue({
        "test-package": "1.0.0",
      });
      mockPackageManager.getInstalledVersion.mockResolvedValue(null);
      mockWithRetry.mockResolvedValue("1.1.0");

      const result = await dependencyChecker.checkForUpdates();

      expect(result.updatable).toHaveLength(1);
      expect(result.updatable[0].installedVersion).toBeUndefined();
    });

    test("should handle getLatestVersion returning fallback version", async () => {
      mockPackageManager.getDependencies.mockResolvedValue({
        "test-package": "1.0.0",
      });
      mockWithRetry.mockRejectedValue(new Error("Network error"));

      const result = await dependencyChecker.checkForUpdates();

      expect(result.updatable).toHaveLength(0);
      expect(result.breakingChanges).toHaveLength(0);
    });

    test("should handle DependencyError in getLatestVersion", async () => {
      mockPackageManager.getDependencies.mockResolvedValue({
        "test-package": "1.0.0",
      });
      mockWithRetry.mockRejectedValue(
        new DependencyError("Dependency error", "test-package")
      );

      const result = await dependencyChecker.checkForUpdates();

      expect(result.updatable).toHaveLength(0);
      expect(result.breakingChanges).toHaveLength(0);

      const { logger } = require("../../src/utils/logger");
      expect(logger.error).toHaveBeenCalled();
    });
  });
});
