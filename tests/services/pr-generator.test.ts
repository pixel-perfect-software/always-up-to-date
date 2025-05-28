import { createPullRequest } from "../../src/services/pr-generator";
import { execSync } from "child_process";

// Mock child_process and logger
jest.mock("child_process");
jest.mock("../../src/utils/logger", () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

describe("PR Generator Service", () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset environment variables
    process.env = { ...originalEnv };
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  test("should handle missing GITHUB_TOKEN gracefully", async () => {
    delete process.env.GITHUB_TOKEN;

    const updates = [
      {
        name: "package1",
        currentVersion: "1.0.0",
        newVersion: "2.0.0",
        hasBreakingChanges: false,
      },
    ];

    // Should not throw but log error
    await createPullRequest(updates);

    const { logger } = require("../../src/utils/logger");
    expect(logger.error).toHaveBeenCalledWith(
      "GITHUB_TOKEN environment variable is not set"
    );
  });

  test("should handle missing repository info gracefully", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    mockExecSync.mockImplementation(() => {
      throw new Error("No git remote");
    });

    const updates = [
      {
        name: "error-package",
        currentVersion: "1.0.0",
        newVersion: "2.0.0",
        hasBreakingChanges: false,
      },
    ];

    // Should not throw but log error
    await createPullRequest(updates);

    const { logger } = require("../../src/utils/logger");
    expect(logger.error).toHaveBeenCalledWith(
      "Could not determine repository owner and name"
    );
  });

  test("should attempt to create PR with proper environment", async () => {
    process.env.GITHUB_TOKEN = "test-token";
    process.env.REPO_OWNER = "test-owner";
    process.env.REPO_NAME = "test-repo";

    mockExecSync.mockReturnValue(
      Buffer.from("https://github.com/test-owner/test-repo.git")
    );

    const updates = [
      {
        name: "package1",
        currentVersion: "1.0.0",
        newVersion: "2.0.0",
        hasBreakingChanges: false,
      },
    ];

    // Should not throw
    await createPullRequest(updates);

    // Should have tried to get git remote
    expect(mockExecSync).toHaveBeenCalledWith("git remote get-url origin");
  });
});
