import { checkDependencies } from "../../src/services/dependency-checker";
import { execSync } from "child_process";

// Mock child_process
jest.mock("child_process");
jest.mock("../../src/utils/logger", () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
  },
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe("Dependency Checker Service", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

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
