import { checkDependencies } from "../../src/commands/check";
import { checkForUpdates } from "../../src/services/dependency-checker";
import { logger } from "../../src/utils/logger";
import { PackageManagerDetector } from "../../src/utils/package-manager";
import * as inquirer from "@inquirer/prompts";

// Mock dependencies
jest.mock("../../src/services/dependency-checker");
jest.mock("../../src/utils/logger");
jest.mock("../../src/utils/package-manager");
jest.mock("@inquirer/prompts");

const mockCheckForUpdates = checkForUpdates as jest.MockedFunction<
  typeof checkForUpdates
>;
const mockLogger = logger as jest.Mocked<typeof logger>;
const mockPackageManagerDetector = PackageManagerDetector as jest.Mocked<
  typeof PackageManagerDetector
>;
const mockInquirer = inquirer as jest.Mocked<typeof inquirer>;

// Helper function to check if logger was called with a specific message
const expectLoggerToHaveBeenCalledWith = (
  loggerMethod: jest.MockedFunction<any>,
  message: string
) => {
  const calls = loggerMethod.mock.calls;
  const found = calls.some(
    (call) =>
      call[0] === message ||
      (typeof call[0] === "string" && call[0].includes(message))
  );
  expect(found).toBe(true);
};

// Create mock package manager
const mockPackageManager = {
  updateDependency: jest.fn(),
  install: jest.fn(),
  uninstall: jest.fn(),
  getDependencies: jest.fn(),
  checkOutdated: jest.fn(),
  getInstalledVersion: jest.fn(),
};

describe("Check Command", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Setup default mocks
    mockPackageManagerDetector.detect.mockReturnValue(
      mockPackageManager as any
    );
    mockCheckForUpdates.mockResolvedValue({
      updatable: [],
      breakingChanges: [],
    });
  });

  describe("Basic functionality", () => {
    test("should identify updatable dependencies", async () => {
      const mockUpdatable = [
        {
          name: "test-package",
          currentVersion: "1.0.0",
          newVersion: "1.1.0",
          hasBreakingChanges: false,
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: mockUpdatable,
        breakingChanges: [],
      });

      const result = await checkDependencies();

      expect(result).toHaveProperty("updatable");
      expect(Array.isArray(result.updatable)).toBe(true);
      expect(result.updatable).toEqual(mockUpdatable);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Checking for dependency updates..."
      );
    });

    test("should handle no updatable dependencies", async () => {
      mockCheckForUpdates.mockResolvedValue({
        updatable: [],
        breakingChanges: [],
      });

      const result = await checkDependencies();

      expect(result.updatable.length).toBe(0);
      expectLoggerToHaveBeenCalledWith(
        mockLogger.info,
        "Checking for dependency updates..."
      );
      expectLoggerToHaveBeenCalledWith(
        mockLogger.info,
        "✅ All dependencies are up to date."
      );
    });

    test("should return breaking changes if present", async () => {
      const mockBreakingChanges = [
        {
          name: "breaking-package",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: true,
          migrationInstructions: "Update your imports",
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: [],
        breakingChanges: mockBreakingChanges,
      });

      const result = await checkDependencies();

      expect(result).toHaveProperty("breakingChanges");
      expect(Array.isArray(result.breakingChanges)).toBe(true);
      expect(result.breakingChanges).toEqual(mockBreakingChanges);
    });

    test("should provide migration instructions for breaking changes", async () => {
      const mockBreakingChanges = [
        {
          name: "breaking-package",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: true,
          migrationInstructions: "Update your imports and change API calls",
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: [],
        breakingChanges: mockBreakingChanges,
      });

      const result = await checkDependencies();

      if (result.breakingChanges.length > 0) {
        expect(result.breakingChanges[0]).toHaveProperty(
          "migrationInstructions"
        );
        expect(result.breakingChanges[0].migrationInstructions).toBe(
          "Update your imports and change API calls"
        );
      }
    });

    test("should handle mixed updatable and breaking changes", async () => {
      const mockUpdatable = [
        {
          name: "safe-package",
          currentVersion: "1.0.0",
          newVersion: "1.1.0",
          hasBreakingChanges: false,
        },
      ];

      const mockBreakingChanges = [
        {
          name: "breaking-package",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: true,
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: mockUpdatable,
        breakingChanges: mockBreakingChanges,
      });

      const result = await checkDependencies();

      expect(result.updatable).toEqual(mockUpdatable);
      expect(result.breakingChanges).toEqual(mockBreakingChanges);
    });
  });

  describe("Preview mode", () => {
    test("should handle preview mode correctly", async () => {
      const mockUpdatable = [
        {
          name: "test-package",
          currentVersion: "1.0.0",
          newVersion: "1.1.0",
          hasBreakingChanges: false,
        },
      ];

      const mockBreakingChanges = [
        {
          name: "breaking-package",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: true,
          migrationInstructions: "Migration guide available",
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: mockUpdatable,
        breakingChanges: mockBreakingChanges,
      });

      const result = await checkDependencies({ preview: true });

      expect(result).toHaveProperty("updatable");
      expect(result).toHaveProperty("breakingChanges");
      expect(result.updatable).toEqual(mockUpdatable);
      expect(result.breakingChanges).toEqual(mockBreakingChanges);
      expectLoggerToHaveBeenCalledWith(
        mockLogger.info,
        "🔍 Preview Mode: Checking for dependency updates..."
      );
      expectLoggerToHaveBeenCalledWith(mockLogger.info, "📋 PREVIEW REPORT");
    });

    test("should display preview report with safe updates", async () => {
      const mockUpdatable = [
        {
          name: "test-package",
          currentVersion: "1.0.0",
          newVersion: "1.1.0",
          hasBreakingChanges: false,
        },
        {
          name: "another-package",
          currentVersion: "2.0.0",
          installedVersion: "1.9.0",
          newVersion: "2.1.0",
          hasBreakingChanges: false,
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: mockUpdatable,
        breakingChanges: [],
      });

      await checkDependencies({ preview: true });

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("📋 PREVIEW REPORT")
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("✅ Safe Updates (2)")
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("test-package")
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("another-package")
      );
    });

    test("should display preview report with breaking changes", async () => {
      const mockBreakingChanges = [
        {
          name: "breaking-package",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: true,
          migrationInstructions: "Migration guide available",
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: [],
        breakingChanges: mockBreakingChanges,
      });

      await checkDependencies({ preview: true });

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("⚠️  Breaking Changes (1)")
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("breaking-package")
      );
    });

    test("should handle preview mode with no updates", async () => {
      mockCheckForUpdates.mockResolvedValue({
        updatable: [],
        breakingChanges: [],
      });

      const result = await checkDependencies({ preview: true });

      expect(result).toEqual({ updatable: [], breakingChanges: [] });
      expectLoggerToHaveBeenCalledWith(
        mockLogger.info,
        "🔍 Preview Mode: Checking for dependency updates..."
      );
      expectLoggerToHaveBeenCalledWith(
        mockLogger.info,
        "✅ All dependencies are up to date."
      );
    });
  });

  describe("Interactive mode", () => {
    test("should handle interactive mode with no updates", async () => {
      mockCheckForUpdates.mockResolvedValue({
        updatable: [],
        breakingChanges: [],
      });

      const result = await checkDependencies({ interactive: true });

      expect(result).toEqual({ updatable: [], breakingChanges: [] });
      expectLoggerToHaveBeenCalledWith(
        mockLogger.info,
        "🔄 Interactive Mode: Checking for dependency updates..."
      );
      expectLoggerToHaveBeenCalledWith(
        mockLogger.info,
        "✅ All dependencies are up to date."
      );
    });

    test("should handle interactive mode with updates available", async () => {
      const mockUpdatable = [
        {
          name: "safe-package",
          currentVersion: "1.0.0",
          newVersion: "1.1.0",
          hasBreakingChanges: false,
        },
      ];

      const mockBreakingChanges = [
        {
          name: "breaking-package",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: true,
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: mockUpdatable,
        breakingChanges: mockBreakingChanges,
      });

      // Mock user selecting no packages
      mockInquirer.checkbox.mockResolvedValue([]);

      const result = await checkDependencies({ interactive: true });

      expect(result.updatable).toEqual(mockUpdatable);
      expect(result.breakingChanges).toEqual(mockBreakingChanges);
      expectLoggerToHaveBeenCalledWith(
        mockLogger.info,
        "🔄 Interactive Mode: Checking for dependency updates..."
      );
      expectLoggerToHaveBeenCalledWith(mockLogger.info, "🔄 INTERACTIVE MODE");
      expectLoggerToHaveBeenCalledWith(
        mockLogger.info,
        "No packages selected for update."
      );
    });

    test("should handle interactive mode with package selection", async () => {
      const mockUpdatable = [
        {
          name: "safe-package",
          currentVersion: "1.0.0",
          newVersion: "1.1.0",
          hasBreakingChanges: false,
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: mockUpdatable,
        breakingChanges: [],
      });

      // Mock user selecting packages and confirming
      mockInquirer.checkbox.mockResolvedValue(["safe:safe-package"]);
      mockInquirer.confirm.mockResolvedValue(true);

      const result = await checkDependencies({ interactive: true });

      expect(mockInquirer.checkbox).toHaveBeenCalled();
      expect(mockInquirer.confirm).toHaveBeenCalled();
      expect(mockPackageManager.updateDependency).toHaveBeenCalledWith(
        process.cwd(),
        "safe-package",
        "1.1.0"
      );
    });

    test("should handle interactive mode with breaking changes confirmation", async () => {
      const mockBreakingChanges = [
        {
          name: "breaking-package",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: true,
          migrationInstructions: "Migration guide available",
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: [],
        breakingChanges: mockBreakingChanges,
      });

      // Mock user selecting breaking changes but declining confirmation
      mockInquirer.checkbox.mockResolvedValue(["breaking:breaking-package"]);
      mockInquirer.confirm.mockResolvedValueOnce(false); // Decline breaking changes

      const result = await checkDependencies({ interactive: true });

      expect(mockInquirer.confirm).toHaveBeenCalledWith({
        message: "Do you want to continue with these breaking changes?",
        default: false,
      });
      expectLoggerToHaveBeenCalledWith(
        mockLogger.info,
        "🔄 Interactive Mode: Checking for dependency updates..."
      );
      expectLoggerToHaveBeenCalledWith(mockLogger.info, "Update cancelled.");
    });

    test("should handle interactive mode update cancellation", async () => {
      const mockUpdatable = [
        {
          name: "safe-package",
          currentVersion: "1.0.0",
          newVersion: "1.1.0",
          hasBreakingChanges: false,
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: mockUpdatable,
        breakingChanges: [],
      });

      // Mock user selecting packages but declining update
      mockInquirer.checkbox.mockResolvedValue(["safe:safe-package"]);
      mockInquirer.confirm.mockResolvedValue(false);

      const result = await checkDependencies({ interactive: true });

      expect(mockInquirer.confirm).toHaveBeenCalledWith({
        message: "Apply 1 package update(s)?",
        default: true,
      });
      expectLoggerToHaveBeenCalledWith(
        mockLogger.info,
        "🔄 Interactive Mode: Checking for dependency updates..."
      );
      expectLoggerToHaveBeenCalledWith(mockLogger.info, "Update cancelled.");
      expect(mockPackageManager.updateDependency).not.toHaveBeenCalled();
    });

    test("should handle interactive mode update errors", async () => {
      const mockUpdatable = [
        {
          name: "safe-package",
          currentVersion: "1.0.0",
          newVersion: "1.1.0",
          hasBreakingChanges: false,
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: mockUpdatable,
        breakingChanges: [],
      });

      // Mock user selecting packages and confirming
      mockInquirer.checkbox.mockResolvedValue(["safe:safe-package"]);
      mockInquirer.confirm.mockResolvedValue(true);

      // Mock package manager throwing error
      mockPackageManager.updateDependency.mockRejectedValue(
        new Error("Update failed")
      );

      const result = await checkDependencies({ interactive: true });

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("❌ Error applying updates: Update failed")
      );
    });
  });

  describe("Default mode", () => {
    test("should display default mode output with updatable dependencies", async () => {
      const mockUpdatable = [
        {
          name: "test-package",
          currentVersion: "1.0.0",
          newVersion: "1.1.0",
          hasBreakingChanges: false,
        },
        {
          name: "version-mismatch-package",
          currentVersion: "2.0.0",
          installedVersion: "1.9.0",
          newVersion: "2.1.0",
          hasBreakingChanges: false,
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: mockUpdatable,
        breakingChanges: [],
      });

      const result = await checkDependencies();

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("📦 The following dependencies can be updated:")
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("test-package")
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("version-mismatch-package")
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          "💡 Tip: Use --interactive to select specific updates or --preview for detailed information."
        )
      );
    });

    test("should display default mode output with breaking changes", async () => {
      const mockBreakingChanges = [
        {
          name: "breaking-package",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: true,
          migrationInstructions: "Migration guide available",
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: [],
        breakingChanges: mockBreakingChanges,
      });

      const result = await checkDependencies();

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "⚠️  The following dependencies have breaking changes:"
        )
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining("breaking-package")
      );
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "    Migration instructions available (use --interactive to view)"
      );
    });
  });

  describe("Error handling", () => {
    test("should handle errors gracefully", async () => {
      mockCheckForUpdates.mockRejectedValue(new Error("Service error"));

      const result = await checkDependencies({ projectPath: "/invalid/path" });

      expect(result).toEqual({ updatable: [], breakingChanges: [] });
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "An error occurred while checking dependencies: Service error"
        )
      );
    });

    test("should handle service errors in checkForUpdates", async () => {
      mockCheckForUpdates.mockRejectedValue(new Error("Network timeout"));

      const result = await checkDependencies();

      expect(result).toEqual({ updatable: [], breakingChanges: [] });
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "An error occurred while checking dependencies: Network timeout"
        )
      );
    });

    test("should handle undefined error messages", async () => {
      mockCheckForUpdates.mockRejectedValue("String error");

      const result = await checkDependencies();

      expect(result).toEqual({ updatable: [], breakingChanges: [] });
      expect(mockLogger.error).toHaveBeenCalled();
    });
  });

  describe("Different argument combinations", () => {
    test("should handle custom project path", async () => {
      const customPath = "/custom/project/path";

      mockCheckForUpdates.mockResolvedValue({
        updatable: [],
        breakingChanges: [],
      });

      await checkDependencies({ projectPath: customPath });

      expect(mockCheckForUpdates).toHaveBeenCalledWith(customPath);
    });

    test("should handle undefined arguments", async () => {
      mockCheckForUpdates.mockResolvedValue({
        updatable: [],
        breakingChanges: [],
      });

      const result = await checkDependencies(undefined);

      expect(result).toEqual({ updatable: [], breakingChanges: [] });
      expect(mockCheckForUpdates).toHaveBeenCalledWith(undefined);
    });

    test("should handle empty arguments object", async () => {
      mockCheckForUpdates.mockResolvedValue({
        updatable: [],
        breakingChanges: [],
      });

      const result = await checkDependencies({});

      expect(result).toEqual({ updatable: [], breakingChanges: [] });
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Checking for dependency updates..."
      );
    });
  });

  describe("Backwards compatibility", () => {
    test("should export check function for backwards compatibility", async () => {
      const { check } = await import("../../src/commands/check");

      mockCheckForUpdates.mockResolvedValue({
        updatable: [],
        breakingChanges: [],
      });

      const result = await check();

      expect(result).toEqual({ updatable: [], breakingChanges: [] });
      expect(typeof check).toBe("function");
    });
  });

  describe("Logger integration", () => {
    test("should use appropriate log levels", async () => {
      const mockUpdatable = [
        {
          name: "test-package",
          currentVersion: "1.0.0",
          newVersion: "1.1.0",
          hasBreakingChanges: false,
        },
      ];

      const mockBreakingChanges = [
        {
          name: "breaking-package",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: true,
          migrationInstructions: "Migration available",
        },
      ];

      mockCheckForUpdates.mockResolvedValue({
        updatable: mockUpdatable,
        breakingChanges: mockBreakingChanges,
      });

      await checkDependencies();

      // Should use info for general messages
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Checking for dependency updates..."
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("📦 The following dependencies can be updated:")
      );

      // Should use warn for breaking changes
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "⚠️  The following dependencies have breaking changes:"
        )
      );

      // Should use debug for migration instructions note
      expect(mockLogger.debug).toHaveBeenCalledWith(
        "    Migration instructions available (use --interactive to view)"
      );
    });
  });
});
