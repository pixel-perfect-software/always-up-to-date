import { autoUpdateDependencies, autoUpdate } from "../../src/commands/auto";
import { updateDependencies } from "../../src/services/dependency-checker";
import { createPullRequest } from "../../src/services/pr-generator";
import { createBackup } from "../../src/commands/rollback";
import { logger } from "../../src/utils/logger";

// Mock dependencies
jest.mock("../../src/services/dependency-checker");
jest.mock("../../src/services/pr-generator");
jest.mock("../../src/commands/rollback");
jest.mock("../../src/utils/logger");

const mockUpdateDependencies = updateDependencies as jest.MockedFunction<
  typeof updateDependencies
>;
const mockCreatePullRequest = createPullRequest as jest.MockedFunction<
  typeof createPullRequest
>;
const mockCreateBackup = createBackup as jest.MockedFunction<
  typeof createBackup
>;
const mockLogger = logger as jest.Mocked<typeof logger>;

interface DependencyUpdate {
  name: string;
  currentVersion: string;
  newVersion: string;
  hasBreakingChanges: boolean;
  migrationInstructions?: string;
}

describe("Auto Command", () => {
  beforeEach(() => {
    jest.clearAllMocks();

    // Reset environment variables
    delete process.env.CREATE_PR;

    // Setup default mocks
    mockCreateBackup.mockResolvedValue(true);
    mockCreatePullRequest.mockResolvedValue(undefined);
  });

  describe("autoUpdateDependencies", () => {
    it("should handle successful updates with PR creation via createIssue flag", async () => {
      const mockUpdates: DependencyUpdate[] = [
        {
          name: "lodash",
          currentVersion: "4.17.20",
          newVersion: "4.17.21",
          hasBreakingChanges: false,
        },
        {
          name: "react",
          currentVersion: "17.0.0",
          newVersion: "18.0.0",
          hasBreakingChanges: true,
        },
      ];

      mockUpdateDependencies.mockResolvedValue(mockUpdates);

      const result = await autoUpdateDependencies({ createIssue: true });

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting automatic dependency update..."
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Creating backup before updates..."
      );
      expect(mockCreateBackup).toHaveBeenCalledWith(undefined);
      expect(mockUpdateDependencies).toHaveBeenCalledWith(undefined);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "2 dependencies updated successfully"
      );
      expect(mockCreatePullRequest).toHaveBeenCalledWith(mockUpdates);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Pull request created for dependency updates."
      );

      expect(result).toEqual({
        updated: mockUpdates,
        prCreated: true,
      });
    });

    it("should handle successful updates with PR creation via CREATE_PR environment variable", async () => {
      process.env.CREATE_PR = "true";

      const mockUpdates: DependencyUpdate[] = [
        {
          name: "express",
          currentVersion: "4.17.1",
          newVersion: "4.18.0",
          hasBreakingChanges: false,
        },
      ];

      mockUpdateDependencies.mockResolvedValue(mockUpdates);

      const result = await autoUpdateDependencies();

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting automatic dependency update..."
      );
      expect(mockCreateBackup).toHaveBeenCalledWith(undefined);
      expect(mockUpdateDependencies).toHaveBeenCalledWith(undefined);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "1 dependencies updated successfully"
      );
      expect(mockCreatePullRequest).toHaveBeenCalledWith(mockUpdates);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Pull request created for dependency updates."
      );

      expect(result).toEqual({
        updated: mockUpdates,
        prCreated: true,
      });
    });

    it("should handle successful updates without PR creation", async () => {
      const mockUpdates: DependencyUpdate[] = [
        {
          name: "typescript",
          currentVersion: "4.5.0",
          newVersion: "4.6.0",
          hasBreakingChanges: false,
        },
      ];

      mockUpdateDependencies.mockResolvedValue(mockUpdates);

      const result = await autoUpdateDependencies();

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting automatic dependency update..."
      );
      expect(mockCreateBackup).toHaveBeenCalledWith(undefined);
      expect(mockUpdateDependencies).toHaveBeenCalledWith(undefined);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "1 dependencies updated successfully"
      );
      expect(mockCreatePullRequest).not.toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Skipping PR creation. Run with --createIssue flag or set CREATE_PR=true to create PRs."
      );

      expect(result).toEqual({
        updated: mockUpdates,
        prCreated: false,
      });
    });

    it("should handle no updates available", async () => {
      mockUpdateDependencies.mockResolvedValue([]);

      const result = await autoUpdateDependencies();

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting automatic dependency update..."
      );
      expect(mockCreateBackup).toHaveBeenCalledWith(undefined);
      expect(mockUpdateDependencies).toHaveBeenCalledWith(undefined);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "No dependencies need updating."
      );
      expect(mockCreatePullRequest).not.toHaveBeenCalled();

      expect(result).toEqual({
        updated: [],
        prCreated: false,
      });
    });

    it("should skip backup creation in dry run mode", async () => {
      const mockUpdates: DependencyUpdate[] = [
        {
          name: "jest",
          currentVersion: "27.0.0",
          newVersion: "28.0.0",
          hasBreakingChanges: true,
        },
      ];

      mockUpdateDependencies.mockResolvedValue(mockUpdates);

      const result = await autoUpdateDependencies({ dryRun: true });

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting automatic dependency update..."
      );
      expect(mockCreateBackup).not.toHaveBeenCalled();
      expect(mockUpdateDependencies).toHaveBeenCalledWith(undefined);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "1 dependencies updated successfully"
      );

      expect(result).toEqual({
        updated: mockUpdates,
        prCreated: false,
      });
    });

    it("should pass projectPath to createBackup and updateDependencies", async () => {
      const projectPath = "/path/to/project";
      const mockUpdates: DependencyUpdate[] = [
        {
          name: "webpack",
          currentVersion: "5.0.0",
          newVersion: "5.1.0",
          hasBreakingChanges: false,
        },
      ];

      mockUpdateDependencies.mockResolvedValue(mockUpdates);

      const result = await autoUpdateDependencies({ projectPath });

      expect(mockCreateBackup).toHaveBeenCalledWith(projectPath);
      expect(mockUpdateDependencies).toHaveBeenCalledWith(projectPath);

      expect(result).toEqual({
        updated: mockUpdates,
        prCreated: false,
      });
    });

    it("should handle errors from createBackup", async () => {
      const backupError = new Error("Backup failed");
      mockCreateBackup.mockRejectedValue(backupError);

      const result = await autoUpdateDependencies();

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting automatic dependency update..."
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Creating backup before updates..."
      );
      expect(mockCreateBackup).toHaveBeenCalledWith(undefined);
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Error during auto-update: Backup failed"
      );
      expect(mockUpdateDependencies).not.toHaveBeenCalled();

      expect(result).toEqual({
        updated: [],
        prCreated: false,
      });
    });

    it("should handle errors from updateDependencies", async () => {
      const updateError = new Error("Update failed");
      mockUpdateDependencies.mockRejectedValue(updateError);

      const result = await autoUpdateDependencies();

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting automatic dependency update..."
      );
      expect(mockCreateBackup).toHaveBeenCalledWith(undefined);
      expect(mockUpdateDependencies).toHaveBeenCalledWith(undefined);
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Error during auto-update: Update failed"
      );

      expect(result).toEqual({
        updated: [],
        prCreated: false,
      });
    });

    it("should handle errors from createPullRequest", async () => {
      const mockUpdates: DependencyUpdate[] = [
        {
          name: "axios",
          currentVersion: "0.24.0",
          newVersion: "0.25.0",
          hasBreakingChanges: false,
        },
      ];
      const prError = new Error("PR creation failed");

      mockUpdateDependencies.mockResolvedValue(mockUpdates);
      mockCreatePullRequest.mockRejectedValue(prError);

      const result = await autoUpdateDependencies({ createIssue: true });

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting automatic dependency update..."
      );
      expect(mockCreateBackup).toHaveBeenCalledWith(undefined);
      expect(mockUpdateDependencies).toHaveBeenCalledWith(undefined);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "1 dependencies updated successfully"
      );
      expect(mockCreatePullRequest).toHaveBeenCalledWith(mockUpdates);
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Error during auto-update: PR creation failed"
      );

      expect(result).toEqual({
        updated: [],
        prCreated: false,
      });
    });

    it("should handle complex args object with multiple properties", async () => {
      const complexArgs = {
        projectPath: "/complex/project",
        dryRun: false,
        createIssue: false,
        verbose: true,
      };

      const mockUpdates: DependencyUpdate[] = [
        {
          name: "eslint",
          currentVersion: "8.0.0",
          newVersion: "8.1.0",
          hasBreakingChanges: false,
        },
      ];

      mockUpdateDependencies.mockResolvedValue(mockUpdates);

      const result = await autoUpdateDependencies(complexArgs);

      expect(mockCreateBackup).toHaveBeenCalledWith("/complex/project");
      expect(mockUpdateDependencies).toHaveBeenCalledWith("/complex/project");
      expect(mockCreatePullRequest).not.toHaveBeenCalled();

      expect(result).toEqual({
        updated: mockUpdates,
        prCreated: false,
      });
    });
  });

  describe("autoUpdate (backwards compatibility)", () => {
    it("should be an alias for autoUpdateDependencies", () => {
      expect(autoUpdate).toBe(autoUpdateDependencies);
    });

    it("should work the same as autoUpdateDependencies", async () => {
      const mockUpdates: DependencyUpdate[] = [
        {
          name: "moment",
          currentVersion: "2.29.0",
          newVersion: "2.29.1",
          hasBreakingChanges: false,
        },
      ];

      mockUpdateDependencies.mockResolvedValue(mockUpdates);

      const result = await autoUpdate({ createIssue: true });

      expect(mockLogger.info).toHaveBeenCalledWith(
        "Starting automatic dependency update..."
      );
      expect(mockCreatePullRequest).toHaveBeenCalledWith(mockUpdates);

      expect(result).toEqual({
        updated: mockUpdates,
        prCreated: true,
      });
    });
  });
});
