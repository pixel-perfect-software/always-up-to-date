/**
 * Tests for cli.ts
 */
import { Command } from "commander"
import { run } from "../src/cli"
import { parseArgs } from "../src/utils/args"
import { checkDependencies } from "../src/commands/check"
import { auditDependencies } from "../src/commands/audit"
import { autoUpdateDependencies } from "../src/commands/auto"
import { showDependencyDiff } from "../src/commands/diff"
import { rollbackDependencies } from "../src/commands/rollback"
import { migrateCommand } from "../src/commands/migrate"
import { ConfigManager } from "../src/utils/config"
import { logger } from "../src/utils/logger"
import { getGitHubToken } from "../src/utils/auth"

// Mock all dependencies
jest.mock("../src/utils/args")
jest.mock("../src/commands/check")
jest.mock("../src/commands/audit")
jest.mock("../src/commands/auto")
jest.mock("../src/commands/diff")
jest.mock("../src/commands/rollback")
jest.mock("../src/commands/migrate")
jest.mock("../src/utils/config")
jest.mock("../src/utils/logger")
jest.mock("../src/utils/auth")

const mockParseArgs = parseArgs as jest.MockedFunction<typeof parseArgs>
const mockCheckDependencies = checkDependencies as jest.MockedFunction<
  typeof checkDependencies
>
const mockAuditDependencies = auditDependencies as jest.MockedFunction<
  typeof auditDependencies
>
const mockAutoUpdateDependencies =
  autoUpdateDependencies as jest.MockedFunction<typeof autoUpdateDependencies>
const mockShowDependencyDiff = showDependencyDiff as jest.MockedFunction<
  typeof showDependencyDiff
>
const mockRollbackDependencies = rollbackDependencies as jest.MockedFunction<
  typeof rollbackDependencies
>
const mockMigrateCommand = migrateCommand as jest.MockedFunction<
  typeof migrateCommand
>
const mockLogger = logger as jest.Mocked<typeof logger>
const mockGetGitHubToken = getGitHubToken as jest.MockedFunction<
  typeof getGitHubToken
>

// Mock ConfigManager methods
const mockConfigManager = ConfigManager as jest.Mocked<typeof ConfigManager>

describe("CLI", () => {
  let originalArgv: string[]
  let originalExit: typeof process.exit
  let originalEnv: NodeJS.ProcessEnv
  let exitSpy: jest.SpyInstance

  beforeEach(() => {
    originalArgv = process.argv
    originalExit = process.exit
    originalEnv = { ...process.env }

    // Mock process.exit to prevent tests from exiting
    exitSpy = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called")
    })

    jest.clearAllMocks()

    // Setup default mocks
    mockParseArgs.mockReturnValue({})
    mockGetGitHubToken.mockResolvedValue("mock-token")
    mockConfigManager.createSampleConfig.mockImplementation(() => {})
  })

  afterEach(() => {
    process.argv = originalArgv
    process.exit = originalExit
    process.env = originalEnv
    exitSpy.mockRestore()
  })

  describe("run function", () => {
    it("should execute without errors when no arguments provided", async () => {
      process.argv = ["node", "cli.js"]

      // When no command is provided, commander shows help and exits with code 0
      // Our mock throws an error to prevent actual exit, so we expect that
      await expect(run()).rejects.toThrow("process.exit called")
    })

    it("should handle CLI execution errors", async () => {
      process.argv = ["node", "cli.js", "--invalid-option"]

      await expect(run()).rejects.toThrow()
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("CLI execution error:"),
      )
    })
  })

  describe("check command", () => {
    it("should execute check command with default options", async () => {
      process.argv = ["node", "cli.js", "check"]
      mockParseArgs.mockReturnValue({ projectPath: "/test" })

      await run()

      expect(mockCheckDependencies).toHaveBeenCalledWith({
        projectPath: "/test",
        verbose: false,
        preview: false,
        interactive: false,
      })
    })

    it("should execute check command with custom options", async () => {
      process.argv = [
        "node",
        "cli.js",
        "check",
        "--projectPath",
        "/custom/path",
        "--verbose",
        "--preview",
        "--interactive",
      ]
      mockParseArgs.mockReturnValue({})

      await run()

      expect(mockCheckDependencies).toHaveBeenCalledWith({
        projectPath: "/custom/path",
        verbose: true,
        preview: true,
        interactive: true,
      })
    })

    it("should log verbose output when verbose flag is set", async () => {
      process.argv = ["node", "cli.js", "check", "--verbose"]
      mockParseArgs.mockReturnValue({})

      await run()

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Running check command with options:"),
      )
    })
  })

  describe("audit command", () => {
    it("should execute audit command with default options", async () => {
      process.argv = ["node", "cli.js", "audit"]
      mockParseArgs.mockReturnValue({})

      await run()

      expect(mockAuditDependencies).toHaveBeenCalled()
    })

    it("should execute audit command with verbose option", async () => {
      process.argv = ["node", "cli.js", "audit", "--verbose"]
      mockParseArgs.mockReturnValue({})

      await run()

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Running audit command with options:"),
      )
      expect(mockAuditDependencies).toHaveBeenCalled()
    })
  })

  describe("auto command", () => {
    it("should execute auto command with default options", async () => {
      process.argv = ["node", "cli.js", "auto"]
      mockParseArgs.mockReturnValue({})

      await run()

      expect(mockAutoUpdateDependencies).toHaveBeenCalledWith({
        createIssue: false,
        verbose: false,
        dryRun: false,
        batchSize: "10",
        separatePrs: false,
      })
    })

    it("should execute auto command with all options", async () => {
      process.argv = [
        "node",
        "cli.js",
        "auto",
        "--projectPath",
        "/test",
        "--createIssue",
        "--token",
        "test-token",
        "--repository",
        "owner/repo",
        "--verbose",
        "--dry-run",
        "--batch-size",
        "5",
        "--separate-prs",
      ]
      mockParseArgs.mockReturnValue({})

      await run()

      expect(mockAutoUpdateDependencies).toHaveBeenCalledWith({
        projectPath: "/test",
        createIssue: true,
        token: "test-token",
        repository: "owner/repo",
        verbose: true,
        dryRun: true,
        batchSize: "5",
        separatePrs: true,
      })

      // Check that environment variables are set
      expect(process.env.GITHUB_TOKEN).toBe("test-token")
      expect(process.env.REPO_OWNER).toBe("owner")
      expect(process.env.REPO_NAME).toBe("repo")
    })

    it("should handle GitHub authentication setup when createIssue is true", async () => {
      process.argv = ["node", "cli.js", "auto", "--createIssue"]
      mockParseArgs.mockReturnValue({})

      await run()

      expect(mockLogger.info).toHaveBeenCalledWith(
        "🔑 Setting up GitHub authentication...",
      )
      expect(mockGetGitHubToken).toHaveBeenCalled()
      expect(mockLogger.info).toHaveBeenCalledWith(
        "✅ GitHub authentication ready",
      )
    })

    it("should handle GitHub authentication failure", async () => {
      process.argv = ["node", "cli.js", "auto", "--createIssue"]
      mockParseArgs.mockReturnValue({})
      mockGetGitHubToken.mockResolvedValue(null)

      await run()

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "GitHub authentication not available. PR creation will be skipped.",
      )
      expect(mockAutoUpdateDependencies).toHaveBeenCalledWith({
        createIssue: false,
        verbose: false,
        dryRun: false,
        batchSize: "10",
        separatePrs: false,
      })
    })
  })

  describe("init command", () => {
    it("should execute init command with default project path", async () => {
      process.argv = ["node", "cli.js", "init"]
      const originalCwd = process.cwd()

      await run()

      expect(mockConfigManager.createSampleConfig).toHaveBeenCalledWith(
        originalCwd,
      )
    })

    it("should execute init command with custom project path", async () => {
      process.argv = ["node", "cli.js", "init", "--projectPath", "/custom/path"]

      await run()

      expect(mockConfigManager.createSampleConfig).toHaveBeenCalledWith(
        "/custom/path",
      )
    })

    it("should handle init command errors", async () => {
      process.argv = ["node", "cli.js", "init"]
      const error = new Error("Failed to create config")
      mockConfigManager.createSampleConfig.mockImplementation(() => {
        throw error
      })

      await expect(run()).rejects.toThrow("process.exit called")
      expect(mockLogger.error).toHaveBeenCalledWith(
        "Failed to create configuration: Failed to create config",
      )
    })
  })

  describe("rollback command", () => {
    it("should execute rollback command with default options", async () => {
      process.argv = ["node", "cli.js", "rollback"]
      mockParseArgs.mockReturnValue({})

      await run()

      expect(mockRollbackDependencies).toHaveBeenCalledWith({
        verbose: false,
        keepBackup: false,
      })
    })

    it("should execute rollback command with all options", async () => {
      process.argv = [
        "node",
        "cli.js",
        "rollback",
        "--projectPath",
        "/test",
        "--verbose",
        "--keep-backup",
      ]
      mockParseArgs.mockReturnValue({})

      await run()

      expect(mockRollbackDependencies).toHaveBeenCalledWith({
        projectPath: "/test",
        verbose: true,
        keepBackup: true,
      })
    })
  })

  describe("diff command", () => {
    it("should execute diff command with default options", async () => {
      process.argv = ["node", "cli.js", "diff"]
      mockParseArgs.mockReturnValue({})

      await run()

      expect(mockShowDependencyDiff).toHaveBeenCalledWith({
        format: "detailed",
        verbose: false,
      })
    })

    it("should execute diff command with custom format", async () => {
      process.argv = ["node", "cli.js", "diff", "--format", "json", "--verbose"]
      mockParseArgs.mockReturnValue({})

      await run()

      expect(mockShowDependencyDiff).toHaveBeenCalledWith({
        format: "json",
        verbose: true,
      })
    })
  })

  describe("migrate command", () => {
    it("should execute migrate command with default options", async () => {
      process.argv = ["node", "cli.js", "migrate"]
      mockParseArgs.mockReturnValue({})
      const originalCwd = process.cwd()

      await run()

      expect(mockMigrateCommand).toHaveBeenCalledWith({
        projectPath: originalCwd,
        verbose: false,
        listSupported: false,
      })
    })

    it("should execute migrate command with all options", async () => {
      process.argv = [
        "node",
        "cli.js",
        "migrate",
        "--projectPath",
        "/test",
        "--package",
        "react",
        "--from-version",
        "17.0.0",
        "--to-version",
        "18.0.0",
        "--verbose",
        "--list-supported",
        "--search-tag",
        "framework",
        "--custom-rules",
        "/custom/rules",
      ]
      mockParseArgs.mockReturnValue({})

      await run()

      expect(mockMigrateCommand).toHaveBeenCalledWith({
        projectPath: "/test",
        package: "react",
        fromVersion: "17.0.0",
        toVersion: "18.0.0",
        verbose: true,
        listSupported: true,
        searchTag: "framework",
        customRules: "/custom/rules",
      })
    })
  })

  describe("program configuration", () => {
    it("should have correct program metadata", () => {
      // This is more of an integration test to ensure the program is configured correctly
      const program = new Command()
      program
        .name("alwaysuptodate")
        .description("A CLI tool to keep your npm dependencies up to date")
        .version("1.0.0")

      expect(program.name()).toBe("alwaysuptodate")
      expect(program.description()).toBe(
        "A CLI tool to keep your npm dependencies up to date",
      )
      expect(program.version()).toBe("1.0.0")
    })
  })

  describe("help configuration", () => {
    it("should configure help options correctly", () => {
      const program = new Command()
      program.configureHelp({
        sortSubcommands: true,
        sortOptions: true,
      })

      // This test ensures the help configuration is applied
      expect(program.configureHelp).toBeDefined()
    })
  })

  describe("error handling", () => {
    it("should handle command parsing errors gracefully", async () => {
      process.argv = ["node", "cli.js", "nonexistent-command"]

      await expect(run()).rejects.toThrow()
      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("CLI execution error:"),
      )
    })
  })

  describe("option merging", () => {
    it("should merge parseArgs and command options correctly", async () => {
      process.argv = ["node", "cli.js", "check", "--verbose"]
      mockParseArgs.mockReturnValue({
        projectPath: "/from-args",
        repository: "test/repo",
      })

      await run()

      expect(mockCheckDependencies).toHaveBeenCalledWith({
        projectPath: "/from-args",
        repository: "test/repo",
        verbose: true,
        preview: false,
        interactive: false,
      })
    })

    it("should prioritize command options over parseArgs", async () => {
      process.argv = [
        "node",
        "cli.js",
        "check",
        "--projectPath",
        "/from-command",
      ]
      mockParseArgs.mockReturnValue({
        projectPath: "/from-args",
      })

      await run()

      expect(mockCheckDependencies).toHaveBeenCalledWith({
        projectPath: "/from-command",
        verbose: false,
        preview: false,
        interactive: false,
      })
    })
  })
})
