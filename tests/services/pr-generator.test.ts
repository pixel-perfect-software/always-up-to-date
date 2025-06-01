import {
  createPullRequest,
  PRGenerator,
} from "../../src/services/pr-generator";
import { execSync } from "child_process";
import { getGitHubToken } from "../../src/utils/auth";
import { Octokit } from "@octokit/rest";

// Mock dependencies
jest.mock("child_process");
jest.mock("../../src/utils/logger", () => ({
  logger: {
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));
jest.mock("../../src/utils/auth", () => ({
  getGitHubToken: jest.fn(),
}));
jest.mock("@octokit/rest");

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;
const mockGetGitHubToken = getGitHubToken as jest.MockedFunction<
  typeof getGitHubToken
>;
const MockOctokit = Octokit as jest.MockedClass<typeof Octokit>;

describe("PR Generator Service", () => {
  const originalEnv = process.env;
  let mockOctokitInstance: any;

  beforeEach(() => {
    // Reset environment variables
    process.env = { ...originalEnv };
    jest.clearAllMocks();

    // Setup Octokit mock
    mockOctokitInstance = {
      pulls: {
        create: jest.fn(),
        list: jest.fn(),
      },
    };
    MockOctokit.mockImplementation(() => mockOctokitInstance);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("createPullRequest function", () => {
    test("should handle missing GITHUB_TOKEN gracefully", async () => {
      delete process.env.GITHUB_TOKEN;

      // Mock getGitHubToken to return null (no token found)
      mockGetGitHubToken.mockResolvedValue(null);

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
        "No GitHub token available. Cannot create pull request."
      );
    });

    test("should handle missing repository info gracefully", async () => {
      // Mock getGitHubToken to return a valid token
      mockGetGitHubToken.mockResolvedValue("test-token");

      mockExecSync.mockImplementationOnce(() => {
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

    test("should extract repo info from git remote URL", async () => {
      // Mock getGitHubToken to return a valid token
      mockGetGitHubToken.mockResolvedValue("test-token");

      mockExecSync
        .mockReturnValueOnce(
          Buffer.from("https://github.com/test-owner/test-repo.git")
        )
        .mockReturnValueOnce(Buffer.from("main")) // getCurrentBranch
        .mockReturnValueOnce(Buffer.from("")) // hasChangesToCommit
        .mockReturnValueOnce(Buffer.from("main")); // switch back to original branch

      const updates = [
        {
          name: "package1",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: false,
        },
      ];

      await createPullRequest(updates);

      // Should have tried to get git remote
      expect(mockExecSync).toHaveBeenCalledWith("git remote get-url origin");
    });

    test("should handle git remote SSH URL format", async () => {
      mockGetGitHubToken.mockResolvedValue("test-token");

      mockExecSync
        .mockReturnValueOnce(
          Buffer.from("git@github.com:test-owner/test-repo.git")
        )
        .mockReturnValueOnce(Buffer.from("main")) // getCurrentBranch
        .mockReturnValueOnce(Buffer.from("")) // hasChangesToCommit
        .mockReturnValueOnce(Buffer.from("main")); // switch back to original branch

      const updates = [
        {
          name: "package1",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: false,
        },
      ];

      await createPullRequest(updates);

      expect(mockExecSync).toHaveBeenCalledWith("git remote get-url origin");
    });

    test("should fallback to environment variables for repo info", async () => {
      mockGetGitHubToken.mockResolvedValue("test-token");
      process.env.REPO_OWNER = "env-owner";
      process.env.REPO_NAME = "env-repo";

      mockExecSync.mockImplementationOnce(() => {
        throw new Error("No git remote");
      });

      const updates = [
        {
          name: "package1",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: false,
        },
      ];

      await createPullRequest(updates);

      // Should have tried git remote first
      expect(mockExecSync).toHaveBeenCalledWith("git remote get-url origin");
    });

    test("should handle createPullRequest errors gracefully", async () => {
      mockGetGitHubToken.mockResolvedValue("test-token");

      mockExecSync.mockReturnValueOnce(
        Buffer.from("https://github.com/test-owner/test-repo.git")
      );

      // Mock PRGenerator to throw an error
      const originalPRGenerator =
        require("../../src/services/pr-generator").PRGenerator;
      const mockGeneratePRForDependencyUpdate = jest
        .fn()
        .mockRejectedValue(new Error("PR creation failed"));

      jest
        .spyOn(originalPRGenerator.prototype, "generatePRForDependencyUpdate")
        .mockImplementation(mockGeneratePRForDependencyUpdate);

      const updates = [
        {
          name: "package1",
          currentVersion: "1.0.0",
          newVersion: "2.0.0",
          hasBreakingChanges: false,
        },
      ];

      await createPullRequest(updates);

      const { logger } = require("../../src/utils/logger");
      expect(logger.error).toHaveBeenCalledWith(
        "Error creating pull request: PR creation failed"
      );
    });
  });

  describe("PRGenerator class", () => {
    let prGenerator: PRGenerator;

    beforeEach(() => {
      prGenerator = new PRGenerator("test-token", "test-owner", "test-repo");
    });

    describe("generatePRForDependencyUpdate", () => {
      test("should handle empty updates array", async () => {
        await prGenerator.generatePRForDependencyUpdate([]);

        const { logger } = require("../../src/utils/logger");
        expect(logger.info).toHaveBeenCalledWith(
          "No updates to create a PR for"
        );
      });

      test("should generate PR with regular updates only", async () => {
        const mockDate = "2023-05-15";
        jest
          .spyOn(Date.prototype, "toISOString")
          .mockReturnValue(`${mockDate}T00:00:00.000Z`);

        // Create a mock implementation for createPullRequest to capture the arguments
        let capturedOptions: any;
        jest
          .spyOn(prGenerator, "createPullRequest")
          .mockImplementation(async (options) => {
            capturedOptions = options;
            return Promise.resolve();
          });

        mockOctokitInstance.pulls.list.mockResolvedValue({ data: [] });
        mockOctokitInstance.pulls.create.mockResolvedValue({
          data: { html_url: "https://github.com/test-owner/test-repo/pull/1" },
        });

        const updates = [
          {
            name: "lodash",
            currentVersion: "4.17.20",
            newVersion: "4.17.21",
            hasBreakingChanges: false,
          },
          {
            name: "axios",
            currentVersion: "0.21.1",
            newVersion: "0.21.4",
            hasBreakingChanges: false,
          },
        ];

        // Call the function and await it properly
        await prGenerator.generatePRForDependencyUpdate(updates);

        // Verify our mocked createPullRequest was called with correct parameters
        expect(prGenerator.createPullRequest).toHaveBeenCalled();
        expect(capturedOptions).toBeDefined();
        expect(capturedOptions.title).toBe(
          `chore(deps): update dependencies ${mockDate}`
        );
        expect(capturedOptions.branch).toBe(`dependency-updates-${mockDate}`);
        expect(capturedOptions.body).toContain("## Dependency Updates");
        expect(capturedOptions.body).toContain("### Regular Updates");
        expect(capturedOptions.body).toContain("lodash: 4.17.20 → 4.17.21");
        expect(capturedOptions.body).toContain("axios: 0.21.1 → 0.21.4");
        expect(capturedOptions.body).not.toContain("### Breaking Changes");
      });

      test("should generate PR with breaking changes only", async () => {
        const mockDate = "2023-05-15";
        jest
          .spyOn(Date.prototype, "toISOString")
          .mockReturnValue(`${mockDate}T00:00:00.000Z`);

        // Create a mock implementation for createPullRequest to capture the arguments
        let capturedOptions: any;
        jest
          .spyOn(prGenerator, "createPullRequest")
          .mockImplementation(async (options) => {
            capturedOptions = options;
            return Promise.resolve();
          });

        mockOctokitInstance.pulls.list.mockResolvedValue({ data: [] });
        mockOctokitInstance.pulls.create.mockResolvedValue({
          data: { html_url: "https://github.com/test-owner/test-repo/pull/1" },
        });

        const updates = [
          {
            name: "react",
            currentVersion: "17.0.2",
            newVersion: "18.0.0",
            hasBreakingChanges: true,
            migrationInstructions: "Update to use React 18 features and APIs",
          },
        ];

        // Call the function and make sure it completes
        await prGenerator.generatePRForDependencyUpdate(updates);

        // Verify our mocked createPullRequest was called
        expect(prGenerator.createPullRequest).toHaveBeenCalled();
        expect(capturedOptions).toBeDefined();

        // Assert on the PR body content
        expect(capturedOptions.body).toContain("### Breaking Changes");
        expect(capturedOptions.body).toContain("#### react: 17.0.2 → 18.0.0");
        expect(capturedOptions.body).toContain(
          "Update to use React 18 features and APIs"
        );
        expect(capturedOptions.body).not.toContain("### Regular Updates");
      });

      test("should generate PR with both regular and breaking changes", async () => {
        const mockDate = "2023-05-15";
        jest
          .spyOn(Date.prototype, "toISOString")
          .mockReturnValue(`${mockDate}T00:00:00.000Z`);

        // Create a mock implementation for createPullRequest to capture the arguments
        let capturedOptions: any;
        jest
          .spyOn(prGenerator, "createPullRequest")
          .mockImplementation(async (options) => {
            capturedOptions = options;
            return Promise.resolve();
          });

        mockOctokitInstance.pulls.list.mockResolvedValue({ data: [] });
        mockOctokitInstance.pulls.create.mockResolvedValue({
          data: { html_url: "https://github.com/test-owner/test-repo/pull/1" },
        });

        const updates = [
          {
            name: "lodash",
            currentVersion: "4.17.20",
            newVersion: "4.17.21",
            hasBreakingChanges: false,
          },
          {
            name: "react",
            currentVersion: "17.0.2",
            newVersion: "18.0.0",
            hasBreakingChanges: true,
            migrationInstructions: "Update to use React 18 features",
          },
        ];

        // Call the function and make sure it completes
        await prGenerator.generatePRForDependencyUpdate(updates);

        // Verify our mocked createPullRequest was called with correct parameters
        expect(prGenerator.createPullRequest).toHaveBeenCalled();
        expect(capturedOptions).toBeDefined();
        expect(capturedOptions.body).toContain("### Regular Updates");
        expect(capturedOptions.body).toContain("lodash: 4.17.20 → 4.17.21");
        expect(capturedOptions.body).toContain("### Breaking Changes");
        expect(capturedOptions.body).toContain("#### react: 17.0.2 → 18.0.0");
      });
    });

    describe("createPullRequest", () => {
      test("should create PR when on different branch", async () => {
        mockOctokitInstance.pulls.list.mockResolvedValue({ data: [] });
        mockOctokitInstance.pulls.create.mockResolvedValue({
          data: { html_url: "https://github.com/test-owner/test-repo/pull/1" },
        });

        // Override private methods with spies to avoid implementation details
        jest
          .spyOn(prGenerator as any, "getCurrentBranch")
          .mockReturnValue("main");
        jest
          .spyOn(prGenerator as any, "createAndCheckoutBranch")
          .mockImplementation(() => {});
        jest
          .spyOn(prGenerator as any, "hasChangesToCommit")
          .mockReturnValue(true);
        jest
          .spyOn(prGenerator as any, "checkExistingPR")
          .mockResolvedValue(null);

        // Mock execSync for the specific commands used in the method
        mockExecSync
          .mockReturnValueOnce(Buffer.from("")) // git add
          .mockReturnValueOnce(Buffer.from("")) // git commit
          .mockReturnValueOnce(Buffer.from("")); // git push

        const options = {
          title: "Update dependencies",
          body: "This PR updates several dependencies",
          branch: "feature-branch",
          baseBranch: "main",
        };

        await prGenerator.createPullRequest(options);

        expect(mockOctokitInstance.pulls.create).toHaveBeenCalledWith({
          owner: "test-owner",
          repo: "test-repo",
          title: "Update dependencies",
          body: "This PR updates several dependencies",
          head: "feature-branch",
          base: "main",
        });
      });

      test("should handle no changes to commit", async () => {
        // Use spies for the private methods to avoid implementation details
        jest
          .spyOn(prGenerator as any, "getCurrentBranch")
          .mockReturnValue("feature-branch");
        jest
          .spyOn(prGenerator as any, "hasChangesToCommit")
          .mockReturnValue(false);

        const options = {
          title: "Update dependencies",
          body: "This PR updates several dependencies",
          branch: "feature-branch",
        };

        await prGenerator.createPullRequest(options);

        const { logger } = require("../../src/utils/logger");
        expect(logger.info).toHaveBeenCalledWith(
          "No changes to commit for PR."
        );
        expect(mockOctokitInstance.pulls.create).not.toHaveBeenCalled();
      });

      test("should switch back to original branch when no changes", async () => {
        mockExecSync
          .mockReturnValueOnce(Buffer.from("main")) // getCurrentBranch
          .mockReturnValueOnce(Buffer.from("")) // createAndCheckoutBranch - git branch --list
          .mockReturnValueOnce(Buffer.from("")) // git checkout -b
          .mockReturnValueOnce(Buffer.from("")) // hasChangesToCommit - no changes
          .mockReturnValueOnce(Buffer.from("")); // git checkout main

        const options = {
          title: "Update dependencies",
          body: "This PR updates several dependencies",
          branch: "feature-branch",
        };

        await prGenerator.createPullRequest(options);

        expect(mockExecSync).toHaveBeenCalledWith("git checkout main", {
          stdio: "pipe",
        });
      });

      test("should handle existing PR", async () => {
        mockOctokitInstance.pulls.list.mockResolvedValue({
          data: [
            { html_url: "https://github.com/test-owner/test-repo/pull/1" },
          ],
        });

        mockExecSync
          .mockReturnValueOnce(Buffer.from("feature-branch")) // getCurrentBranch
          .mockReturnValueOnce(Buffer.from("M package.json\n")) // hasChangesToCommit
          .mockReturnValueOnce(Buffer.from("")) // git add
          .mockReturnValueOnce(Buffer.from("")) // git commit
          .mockReturnValueOnce(Buffer.from("")); // git push

        const options = {
          title: "Update dependencies",
          body: "This PR updates several dependencies",
          branch: "feature-branch",
        };

        await prGenerator.createPullRequest(options);

        const { logger } = require("../../src/utils/logger");
        expect(logger.info).toHaveBeenCalledWith(
          "Pull request already exists: https://github.com/test-owner/test-repo/pull/1"
        );
        expect(mockOctokitInstance.pulls.create).not.toHaveBeenCalled();
      });

      test("should handle title with quotes in commit message", async () => {
        mockOctokitInstance.pulls.list.mockResolvedValue({ data: [] });
        mockOctokitInstance.pulls.create.mockResolvedValue({
          data: { html_url: "https://github.com/test-owner/test-repo/pull/1" },
        });

        mockExecSync
          .mockReturnValueOnce(Buffer.from("feature-branch")) // getCurrentBranch
          .mockReturnValueOnce(Buffer.from("M package.json\n")) // hasChangesToCommit
          .mockReturnValueOnce(Buffer.from("")) // git add
          .mockReturnValueOnce(Buffer.from("")) // git commit
          .mockReturnValueOnce(Buffer.from("")); // git push

        const options = {
          title: 'Update "special" dependencies',
          body: "This PR updates several dependencies",
          branch: "feature-branch",
        };

        await prGenerator.createPullRequest(options);

        expect(mockExecSync).toHaveBeenCalledWith(
          'git commit -m "Update \\"special\\" dependencies"',
          { stdio: "pipe" }
        );
      });

      test("should handle git errors", async () => {
        mockExecSync
          .mockReturnValueOnce(Buffer.from("feature-branch")) // getCurrentBranch
          .mockReturnValueOnce(Buffer.from("M package.json\n")) // hasChangesToCommit
          .mockReturnValueOnce(Buffer.from("")) // git add
          .mockImplementationOnce(() => {
            throw new Error("Git commit failed");
          });

        const options = {
          title: "Update dependencies",
          body: "This PR updates several dependencies",
          branch: "feature-branch",
        };

        await expect(prGenerator.createPullRequest(options)).rejects.toThrow(
          "Git commit failed"
        );

        const { logger } = require("../../src/utils/logger");
        expect(logger.error).toHaveBeenCalledWith(
          "Error creating PR: Git commit failed"
        );
      });
    });

    describe("Branch management", () => {
      test("should checkout existing local branch", async () => {
        mockExecSync
          .mockReturnValueOnce(Buffer.from("main")) // getCurrentBranch
          .mockReturnValueOnce(Buffer.from("  feature-branch\n  main\n")) // git branch --list
          .mockReturnValueOnce(Buffer.from("")) // git checkout
          .mockReturnValueOnce(Buffer.from("M package.json\n")) // hasChangesToCommit
          .mockReturnValueOnce(Buffer.from("")) // git add
          .mockReturnValueOnce(Buffer.from("")) // git commit
          .mockReturnValueOnce(Buffer.from("")); // git push

        mockOctokitInstance.pulls.list.mockResolvedValue({ data: [] });
        mockOctokitInstance.pulls.create.mockResolvedValue({
          data: { html_url: "https://github.com/test-owner/test-repo/pull/1" },
        });

        const options = {
          title: "Update dependencies",
          body: "This PR updates several dependencies",
          branch: "feature-branch",
        };

        await prGenerator.createPullRequest(options);

        expect(mockExecSync).toHaveBeenCalledWith(
          "git checkout feature-branch",
          { stdio: "pipe" }
        );
      });

      test("should checkout existing remote branch", async () => {
        mockExecSync
          .mockReturnValueOnce(Buffer.from("main")) // getCurrentBranch
          .mockReturnValueOnce(Buffer.from("  main\n")) // git branch --list (no feature-branch)
          .mockReturnValueOnce(Buffer.from("")) // git fetch origin feature-branch
          .mockReturnValueOnce(Buffer.from("")) // git checkout -b feature-branch origin/feature-branch
          .mockReturnValueOnce(Buffer.from("M package.json\n")) // hasChangesToCommit
          .mockReturnValueOnce(Buffer.from("")) // git add
          .mockReturnValueOnce(Buffer.from("")) // git commit
          .mockReturnValueOnce(Buffer.from("")); // git push

        mockOctokitInstance.pulls.list.mockResolvedValue({ data: [] });
        mockOctokitInstance.pulls.create.mockResolvedValue({
          data: { html_url: "https://github.com/test-owner/test-repo/pull/1" },
        });

        const options = {
          title: "Update dependencies",
          body: "This PR updates several dependencies",
          branch: "feature-branch",
        };

        await prGenerator.createPullRequest(options);

        expect(mockExecSync).toHaveBeenCalledWith(
          "git fetch origin feature-branch",
          { stdio: "pipe" }
        );
        expect(mockExecSync).toHaveBeenCalledWith(
          "git checkout -b feature-branch origin/feature-branch",
          { stdio: "pipe" }
        );
      });

      test("should create new branch when branch doesn't exist", async () => {
        mockExecSync
          .mockReturnValueOnce(Buffer.from("main")) // getCurrentBranch
          .mockReturnValueOnce(Buffer.from("  main\n")) // git branch --list
          .mockImplementationOnce(() => {
            throw new Error("Branch doesn't exist on remote");
          }) // git fetch fails
          .mockReturnValueOnce(Buffer.from("")) // git checkout -b new-branch
          .mockReturnValueOnce(Buffer.from("M package.json\n")) // hasChangesToCommit
          .mockReturnValueOnce(Buffer.from("")) // git add
          .mockReturnValueOnce(Buffer.from("")) // git commit
          .mockReturnValueOnce(Buffer.from("")); // git push

        mockOctokitInstance.pulls.list.mockResolvedValue({ data: [] });
        mockOctokitInstance.pulls.create.mockResolvedValue({
          data: { html_url: "https://github.com/test-owner/test-repo/pull/1" },
        });

        const options = {
          title: "Update dependencies",
          body: "This PR updates several dependencies",
          branch: "new-branch",
        };

        await prGenerator.createPullRequest(options);

        expect(mockExecSync).toHaveBeenCalledWith(
          "git checkout -b new-branch",
          { stdio: "pipe" }
        );
      });

      test("should handle branch creation errors", async () => {
        mockExecSync
          .mockReturnValueOnce(Buffer.from("main")) // getCurrentBranch
          .mockImplementationOnce(() => {
            throw new Error("Branch creation failed");
          }); // git branch --list fails

        const options = {
          title: "Update dependencies",
          body: "This PR updates several dependencies",
          branch: "failing-branch",
        };

        await expect(prGenerator.createPullRequest(options)).rejects.toThrow();

        const { logger } = require("../../src/utils/logger");
        expect(logger.error).toHaveBeenCalledWith(
          "Error creating/checking out branch failing-branch: Branch creation failed"
        );
      });
    });

    describe("checkExistingPR", () => {
      test("should handle API errors gracefully", async () => {
        mockOctokitInstance.pulls.list.mockRejectedValue(
          new Error("API Error")
        );

        // Use the private method through createPullRequest
        mockExecSync
          .mockReturnValueOnce(Buffer.from("feature-branch")) // getCurrentBranch
          .mockReturnValueOnce(Buffer.from("M package.json\n")) // hasChangesToCommit
          .mockReturnValueOnce(Buffer.from("")) // git add
          .mockReturnValueOnce(Buffer.from("")) // git commit
          .mockReturnValueOnce(Buffer.from("")); // git push

        mockOctokitInstance.pulls.create.mockResolvedValue({
          data: { html_url: "https://github.com/test-owner/test-repo/pull/1" },
        });

        const options = {
          title: "Update dependencies",
          body: "This PR updates several dependencies",
          branch: "feature-branch",
        };

        await prGenerator.createPullRequest(options);

        const { logger } = require("../../src/utils/logger");
        expect(logger.error).toHaveBeenCalledWith(
          "Error checking existing PR: API Error"
        );
        // Should still create PR despite API error
        expect(mockOctokitInstance.pulls.create).toHaveBeenCalled();
      });
    });
  });
});
