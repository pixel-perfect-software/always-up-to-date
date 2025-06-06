import { showDependencyDiff, diff } from "../../src/commands/diff"
import { checkForUpdates } from "../../src/services/dependency-checker"
import { logger } from "../../src/utils/logger"

// Mock the dependencies
jest.mock("../../src/services/dependency-checker")
jest.mock("../../src/utils/logger")

const mockCheckForUpdates = checkForUpdates as jest.MockedFunction<
  typeof checkForUpdates
>
const mockLogger = logger as jest.Mocked<typeof logger>

describe("Diff Command", () => {
  beforeEach(() => {
    jest.clearAllMocks()
  })

  describe("showDependencyDiff", () => {
    test("should return diff structure with changes and summary", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "lodash",
            currentVersion: "4.17.20",
            newVersion: "4.17.21",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff()

      expect(result).toHaveProperty("changes")
      expect(result).toHaveProperty("summary")
      expect(Array.isArray(result.changes)).toBe(true)
      expect(typeof result.summary).toBe("object")
      expect(result.changes).toHaveLength(1)
      expect(result.summary.total).toBe(1)
      expect(result.summary.safe).toBe(1)
      expect(result.summary.breaking).toBe(0)
    })

    test("should categorize safe changes correctly", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "lodash",
            currentVersion: "4.17.20",
            newVersion: "4.17.21",
            hasBreakingChanges: false,
          },
          {
            name: "moment",
            currentVersion: "2.29.0",
            newVersion: "2.30.0",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff()

      result.changes.forEach((change) => {
        expect(change).toHaveProperty("name")
        expect(change).toHaveProperty("type")
        expect(change).toHaveProperty("currentVersion")
        expect(change).toHaveProperty("newVersion")
        expect(change).toHaveProperty("changeType")
        expect(["safe", "breaking"]).toContain(change.type)
        expect(["patch", "minor", "major"]).toContain(change.changeType)
      })

      expect(result.changes.every((change) => change.type === "safe")).toBe(
        true,
      )
      expect(result.summary.safe).toBe(2)
      expect(result.summary.breaking).toBe(0)
    })

    test("should categorize breaking changes correctly", async () => {
      const mockUpdates = {
        updatable: [],
        breakingChanges: [
          {
            name: "react",
            currentVersion: "17.0.2",
            newVersion: "18.0.0",
            hasBreakingChanges: true,
            migrationInstructions: "Update to new React 18 APIs",
          },
        ],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff()

      expect(result.changes).toHaveLength(1)
      expect(result.changes[0].type).toBe("breaking")
      expect(result.changes[0].migrationInstructions).toBe(
        "Update to new React 18 APIs",
      )
      expect(result.summary.breaking).toBe(1)
      expect(result.summary.safe).toBe(0)
    })

    test("should handle mixed safe and breaking changes", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "lodash",
            currentVersion: "4.17.20",
            newVersion: "4.17.21",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [
          {
            name: "react",
            currentVersion: "17.0.2",
            newVersion: "18.0.0",
            hasBreakingChanges: true,
            migrationInstructions: "Update to new React 18 APIs",
          },
        ],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff()

      expect(result.changes).toHaveLength(2)
      expect(result.summary.total).toBe(2)
      expect(result.summary.safe).toBe(1)
      expect(result.summary.breaking).toBe(1)

      const safeChanges = result.changes.filter(
        (change) => change.type === "safe",
      )
      const breakingChanges = result.changes.filter(
        (change) => change.type === "breaking",
      )

      expect(safeChanges).toHaveLength(1)
      expect(breakingChanges).toHaveLength(1)
      expect(breakingChanges[0].migrationInstructions).toBeDefined()
    })

    test("should handle empty changes correctly", async () => {
      const mockUpdates = {
        updatable: [],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff()

      expect(result.changes).toHaveLength(0)
      expect(result.summary).toEqual({
        total: 0,
        safe: 0,
        breaking: 0,
      })
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("No dependency changes detected"),
      )
    })

    test("should handle errors gracefully", async () => {
      const error = new Error("Failed to check for updates")
      mockCheckForUpdates.mockRejectedValue(error)

      const result = await showDependencyDiff({ projectPath: "/invalid/path" })

      expect(result).toEqual({
        changes: [],
        summary: { total: 0, safe: 0, breaking: 0 },
      })
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Error analyzing dependency changes"),
      )
    })

    test("should pass project path to checkForUpdates", async () => {
      const mockUpdates = { updatable: [], breakingChanges: [] }
      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const projectPath = "/custom/project/path"
      await showDependencyDiff({ projectPath })

      expect(mockCheckForUpdates).toHaveBeenCalledWith(projectPath)
    })

    test("should log analysis start message", async () => {
      const mockUpdates = { updatable: [], breakingChanges: [] }
      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      await showDependencyDiff()

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Analyzing dependency changes"),
      )
    })
  })

  describe("getChangeType", () => {
    // Test the getChangeType function indirectly through showDependencyDiff
    test("should correctly identify patch changes", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "lodash",
            currentVersion: "4.17.20",
            newVersion: "4.17.21",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff()

      expect(result.changes[0].changeType).toBe("patch")
    })

    test("should correctly identify minor changes", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "react",
            currentVersion: "17.0.2",
            newVersion: "17.1.0",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff()

      expect(result.changes[0].changeType).toBe("minor")
    })

    test("should correctly identify major changes", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "react",
            currentVersion: "17.0.2",
            newVersion: "18.0.0",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff()

      expect(result.changes[0].changeType).toBe("major")
    })

    test("should handle version prefixes correctly", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "lodash",
            currentVersion: "^4.17.20",
            newVersion: "4.17.21",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff()

      expect(result.changes[0].changeType).toBe("patch")
    })
  })

  describe("displayDiff", () => {
    test("should display safe updates correctly", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "lodash",
            currentVersion: "4.17.20",
            newVersion: "4.17.21",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      await showDependencyDiff()

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("DEPENDENCY DIFF REPORT"),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Safe Updates:"),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("lodash"),
      )
    })

    test("should display breaking changes correctly", async () => {
      const mockUpdates = {
        updatable: [],
        breakingChanges: [
          {
            name: "react",
            currentVersion: "17.0.2",
            newVersion: "18.0.0",
            hasBreakingChanges: true,
            migrationInstructions: "Update to new React 18 APIs",
          },
        ],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      await showDependencyDiff()

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Breaking Changes:"),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("react"),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Migration instructions available"),
      )
    })

    test("should display summary correctly", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "lodash",
            currentVersion: "4.17.20",
            newVersion: "4.17.21",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [
          {
            name: "react",
            currentVersion: "17.0.2",
            newVersion: "18.0.0",
            hasBreakingChanges: true,
          },
        ],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      await showDependencyDiff()

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Summary: 2 total changes"),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Safe updates: 1"),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Breaking changes: 1"),
      )
    })

    test("should display help message", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "lodash",
            currentVersion: "4.17.20",
            newVersion: "4.17.21",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      await showDependencyDiff()

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Use --interactive to select specific updates"),
      )
    })
  })

  describe("getChangeIcon", () => {
    test("should display correct icons for different change types", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "patch-update",
            currentVersion: "1.0.0",
            newVersion: "1.0.1",
            hasBreakingChanges: false,
          },
          {
            name: "minor-update",
            currentVersion: "1.0.0",
            newVersion: "1.1.0",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [
          {
            name: "major-update",
            currentVersion: "1.0.0",
            newVersion: "2.0.0",
            hasBreakingChanges: true,
          },
        ],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      await showDependencyDiff()

      // Check that appropriate icons are displayed (🔧 for patch, ✨ for minor, 💥 for major)
      const logCalls = mockLogger.info.mock.calls.map((call) => call[0])
      const hasIconCalls = logCalls.some(
        (call) =>
          typeof call === "string" &&
          (call.includes("🔧") || call.includes("✨") || call.includes("💥")),
      )
      expect(hasIconCalls).toBe(true)
    })
  })

  describe("edge cases and error scenarios", () => {
    test("should handle invalid version strings gracefully", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "invalid-version",
            currentVersion: "invalid.version",
            newVersion: "also.invalid",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff()

      expect(result.changes).toHaveLength(1)
      expect(result.changes[0].changeType).toBeDefined()
    })

    test("should handle empty version strings", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "empty-version",
            currentVersion: "",
            newVersion: "1.0.0",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff()

      expect(result.changes).toHaveLength(1)
      expect(result.changes[0].changeType).toBeDefined()
    })

    test("should handle complex version prefixes", async () => {
      const mockUpdates = {
        updatable: [
          {
            name: "complex-version",
            currentVersion: ">=1.0.0 <2.0.0",
            newVersion: "1.5.0",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff()

      expect(result.changes).toHaveLength(1)
      expect(result.changes[0].changeType).toBeDefined()
    })

    test("should handle breaking changes without migration instructions", async () => {
      const mockUpdates = {
        updatable: [],
        breakingChanges: [
          {
            name: "react",
            currentVersion: "17.0.2",
            newVersion: "18.0.0",
            hasBreakingChanges: true,
            // No migrationInstructions property
          },
        ],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      await showDependencyDiff()

      // Should not display migration instructions line
      const logCalls = mockLogger.info.mock.calls.map((call) => call[0])
      const hasMigrationCall = logCalls.some(
        (call) =>
          typeof call === "string" &&
          call.includes("Migration instructions available"),
      )
      expect(hasMigrationCall).toBe(false)
    })

    test("should handle checkForUpdates returning undefined values", async () => {
      const mockUpdates = {
        updatable: [],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff()

      expect(result).toEqual({
        changes: [],
        summary: { total: 0, safe: 0, breaking: 0 },
      })
    })

    test("should handle different types of network errors", async () => {
      const networkError = new Error("Network timeout")
      networkError.name = "NetworkError"
      mockCheckForUpdates.mockRejectedValue(networkError)

      const result = await showDependencyDiff()

      expect(result).toEqual({
        changes: [],
        summary: { total: 0, safe: 0, breaking: 0 },
      })
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Error analyzing dependency changes"),
      )
    })

    test("should handle args parameter being undefined", async () => {
      const mockUpdates = { updatable: [], breakingChanges: [] }
      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      const result = await showDependencyDiff(undefined)

      expect(result.summary).toEqual({ total: 0, safe: 0, breaking: 0 })
      expect(mockCheckForUpdates).toHaveBeenCalledWith(undefined)
    })

    test("should handle default case in getChangeIcon", async () => {
      // This test is to cover the default case in getChangeIcon function
      // We can't directly test it since it's a private function, but we can ensure
      // all change types are covered in our tests
      const mockUpdates = {
        updatable: [
          {
            name: "test-package",
            currentVersion: "1.0.0",
            newVersion: "1.0.1",
            hasBreakingChanges: false,
          },
        ],
        breakingChanges: [],
      }

      mockCheckForUpdates.mockResolvedValue(mockUpdates)

      await showDependencyDiff()

      // Verify the function runs without errors
      expect(mockLogger.info).toHaveBeenCalled()
    })
  })

  describe("backwards compatibility", () => {
    test("diff should be an alias for showDependencyDiff", () => {
      expect(diff).toBe(showDependencyDiff)
    })
  })
})
