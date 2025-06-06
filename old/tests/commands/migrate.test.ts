import { migrateCommand } from "../../src/commands/migrate"
import { MigrationAdvisor } from "../../src/services/migration-advisor"
import { logger } from "../../src/utils/logger"
import * as fs from "fs"
import * as path from "path"

// Mock dependencies
jest.mock("../../src/services/migration-advisor")
jest.mock("../../src/utils/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}))
jest.mock("fs")
jest.mock("path")

const mockMigrationAdvisor = MigrationAdvisor as jest.MockedClass<
  typeof MigrationAdvisor
>
const mockFs = fs as jest.Mocked<typeof fs>
const mockPath = path as jest.Mocked<typeof path>
const mockLogger = logger as jest.Mocked<typeof logger>

describe("Migrate Command", () => {
  let mockAdvisorInstance: jest.Mocked<MigrationAdvisor>
  let mockProcessExit: jest.SpyInstance
  let mockConsoleLog: jest.SpyInstance

  beforeEach(() => {
    jest.clearAllMocks()

    // Mock MigrationAdvisor instance
    mockAdvisorInstance = {
      getSupportedPackages: jest.fn(),
      searchProvidersByTag: jest.fn(),
      getMigrationInstructions: jest.fn(),
      registerCustomProvider: jest.fn(),
    } as any
    mockMigrationAdvisor.mockImplementation(() => mockAdvisorInstance)

    // Mock process.exit to prevent actual exits
    mockProcessExit = jest.spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit called")
    })

    // Mock console.log for output assertions
    mockConsoleLog = jest.spyOn(console, "log").mockImplementation(() => {})

    // Mock path methods
    mockPath.resolve.mockImplementation((input: string) => input)
    mockPath.join.mockImplementation((...args: string[]) => args.join("/"))
  })

  afterEach(() => {
    mockProcessExit.mockRestore()
    mockConsoleLog.mockRestore()
  })

  describe("List Supported Packages", () => {
    it("should list all supported packages", async () => {
      const supportedPackages = ["react", "next", "typescript", "jest"]
      mockAdvisorInstance.getSupportedPackages.mockReturnValue(
        supportedPackages,
      )

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: true,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await migrateCommand(options)

      expect(mockAdvisorInstance.getSupportedPackages).toHaveBeenCalledTimes(1)
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("📦 Supported Packages for Migration:"),
      )
      supportedPackages.forEach((pkg) => {
        expect(mockLogger.info).toHaveBeenCalledWith(
          expect.stringContaining(pkg),
        )
      })
    })

    it("should handle no supported packages", async () => {
      mockAdvisorInstance.getSupportedPackages.mockReturnValue([])

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: true,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await migrateCommand(options)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "No migration providers found.",
      )
    })
  })

  describe("Search by Tag", () => {
    it("should search packages by framework tag", async () => {
      const frameworkPackages = ["react", "next", "vue"]
      mockAdvisorInstance.searchProvidersByTag.mockReturnValue(
        frameworkPackages,
      )

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: false,
        searchTag: "framework",
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await migrateCommand(options)

      expect(mockAdvisorInstance.searchProvidersByTag).toHaveBeenCalledWith(
        "framework",
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('🏷️  Packages tagged with "framework":'),
      )
      frameworkPackages.forEach((pkg) => {
        expect(mockLogger.info).toHaveBeenCalledWith(
          expect.stringContaining(pkg),
        )
      })
    })

    it("should handle no packages found for tag", async () => {
      mockAdvisorInstance.searchProvidersByTag.mockReturnValue([])

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: false,
        searchTag: "nonexistent",
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await migrateCommand(options)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        "No packages found with this tag.",
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          "Available tags: framework, testing, linting, build-tool, transpiler",
        ),
      )
    })
  })

  describe("Specific Package Migration", () => {
    it("should get migration instructions with versions provided", async () => {
      const migrationInstructions =
        "## React 18 Migration Guide\n\nSteps to migrate..."
      mockAdvisorInstance.getMigrationInstructions.mockResolvedValue(
        migrationInstructions,
      )

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: false,
        searchTag: undefined,
        package: "react",
        fromVersion: "17.0.0",
        toVersion: "18.0.0",
        customRules: undefined,
      }

      await migrateCommand(options)

      expect(mockAdvisorInstance.getMigrationInstructions).toHaveBeenCalledWith(
        "react",
        "17.0.0",
        "18.0.0",
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("🔄 Getting migration instructions for react"),
      )
      expect(mockConsoleLog).toHaveBeenCalledWith(migrationInstructions)
    })

    it("should exit when package specified but versions missing", async () => {
      mockFs.existsSync.mockReturnValue(true)

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: false,
        searchTag: undefined,
        package: "react",
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await expect(() => migrateCommand(options)).rejects.toThrow(
        "process.exit called",
      )

      expect(mockLogger.error).toHaveBeenCalledWith(
        "Please specify both --from-version and --to-version for migration instructions",
      )
      expect(mockProcessExit).toHaveBeenCalledWith(1)
    })

    it("should exit when package.json not found and versions missing", async () => {
      mockFs.existsSync.mockReturnValue(false)

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: false,
        searchTag: undefined,
        package: "react",
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await expect(() => migrateCommand(options)).rejects.toThrow(
        "process.exit called",
      )

      expect(mockLogger.error).toHaveBeenCalledWith(
        "package.json not found. Please specify --from-version and --to-version",
      )
      expect(mockProcessExit).toHaveBeenCalledWith(1)
    })
  })

  describe("Project Migration Info", () => {
    const mockPackageJson = {
      dependencies: {
        react: "^17.0.0",
        lodash: "^4.17.21",
      },
      devDependencies: {
        jest: "^28.0.0",
        typescript: "^4.5.0",
      },
    }

    it("should show migration info for supported packages in project", async () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockPackageJson))
      mockAdvisorInstance.getSupportedPackages.mockReturnValue([
        "react",
        "jest",
        "typescript",
      ])

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: false,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await migrateCommand(options)

      expect(mockFs.readFileSync).toHaveBeenCalledWith(
        "/test/project/package.json",
        "utf8",
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          "📋 Migration Support Available for Your Project:",
        ),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("react"),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("jest"),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("typescript"),
      )
    })

    it("should show verbose output with commands", async () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify(mockPackageJson))
      mockAdvisorInstance.getSupportedPackages.mockReturnValue(["react"])

      const options = {
        projectPath: "/test/project",
        verbose: true,
        listSupported: false,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await migrateCommand(options)

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("alwaysuptodate migrate --package react"),
      )
    })

    it("should handle no supported packages in project", async () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          dependencies: {
            lodash: "^4.17.21",
          },
        }),
      )
      mockAdvisorInstance.getSupportedPackages.mockReturnValue([
        "react",
        "jest",
      ])

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: false,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await migrateCommand(options)

      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          "⚠️  No supported packages found in your project.",
        ),
      )
    })

    it("should exit when package.json not found in project", async () => {
      mockFs.existsSync.mockReturnValue(false)

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: false,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await expect(() => migrateCommand(options)).rejects.toThrow(
        "process.exit called",
      )

      expect(mockLogger.error).toHaveBeenCalledWith(
        "package.json not found in project directory",
      )
      expect(mockProcessExit).toHaveBeenCalledWith(1)
    })
  })

  describe("Custom Rules", () => {
    it("should initialize MigrationAdvisor with custom rules path", async () => {
      const customRulesPath = "/custom/rules"
      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: true,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: customRulesPath,
      }

      mockAdvisorInstance.getSupportedPackages.mockReturnValue([])

      await migrateCommand(options)

      expect(mockMigrationAdvisor).toHaveBeenCalledWith(
        undefined,
        customRulesPath,
      )
    })
  })

  describe("Verbose Mode", () => {
    it("should log initialization options in verbose mode", async () => {
      const options = {
        projectPath: "/test/project",
        verbose: true,
        listSupported: true,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      mockAdvisorInstance.getSupportedPackages.mockReturnValue([])

      await migrateCommand(options)

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Migration Advisor initialized with options:"),
      )
    })
  })

  describe("Error Handling", () => {
    it("should handle migration advisor initialization errors", async () => {
      mockMigrationAdvisor.mockImplementation(() => {
        throw new Error("Initialization failed")
      })

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: false,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await expect(() => migrateCommand(options)).rejects.toThrow(
        "process.exit called",
      )

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "Migration command failed: Initialization failed",
        ),
      )
      expect(mockProcessExit).toHaveBeenCalledWith(1)
    })

    it("should handle getMigrationInstructions errors", async () => {
      mockAdvisorInstance.getMigrationInstructions.mockRejectedValue(
        new Error("Failed to get instructions"),
      )

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: false,
        searchTag: undefined,
        package: "react",
        fromVersion: "17.0.0",
        toVersion: "18.0.0",
        customRules: undefined,
      }

      await expect(() => migrateCommand(options)).rejects.toThrow(
        "process.exit called",
      )

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining(
          "Migration command failed: Failed to get instructions",
        ),
      )
      expect(mockProcessExit).toHaveBeenCalledWith(1)
    })

    it("should show stack trace in verbose mode on error", async () => {
      const error = new Error("Test error")
      error.stack = "Test stack trace"
      mockAdvisorInstance.getSupportedPackages.mockImplementation(() => {
        throw error
      })

      const options = {
        projectPath: "/test/project",
        verbose: true,
        listSupported: true,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await expect(() => migrateCommand(options)).rejects.toThrow(
        "process.exit called",
      )

      expect(mockLogger.debug).toHaveBeenCalledWith(
        expect.stringContaining("Stack trace: Test stack trace"),
      )
    })

    it("should handle JSON parsing errors in package.json", async () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue("invalid json")

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: false,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await expect(() => migrateCommand(options)).rejects.toThrow(
        "process.exit called",
      )

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining("Migration command failed:"),
      )
    })
  })

  describe("Project Path Resolution", () => {
    it("should use provided project path", async () => {
      const projectPath = "/custom/project/path"
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: {} }))
      mockAdvisorInstance.getSupportedPackages.mockReturnValue([])

      const options = {
        projectPath,
        verbose: false,
        listSupported: false,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await migrateCommand(options)

      expect(mockPath.resolve).toHaveBeenCalledWith(projectPath)
    })

    it("should use process.cwd() when no project path provided", async () => {
      const originalCwd = process.cwd
      process.cwd = jest.fn().mockReturnValue("/current/working/dir")

      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(JSON.stringify({ dependencies: {} }))
      mockAdvisorInstance.getSupportedPackages.mockReturnValue([])

      const options = {
        projectPath: "",
        verbose: false,
        listSupported: false,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await migrateCommand(options)

      expect(mockPath.resolve).toHaveBeenCalledWith("/current/working/dir")

      process.cwd = originalCwd
    })
  })

  describe("Tips and Information Display", () => {
    it("should display tips after showing project migration info", async () => {
      mockFs.existsSync.mockReturnValue(true)
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          dependencies: { react: "^17.0.0" },
        }),
      )
      mockAdvisorInstance.getSupportedPackages.mockReturnValue(["react"])

      const options = {
        projectPath: "/test/project",
        verbose: false,
        listSupported: false,
        searchTag: undefined,
        package: undefined,
        fromVersion: undefined,
        toVersion: undefined,
        customRules: undefined,
      }

      await migrateCommand(options)

      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("💡 Tips:"),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          "Use --package to get specific migration instructions",
        ),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          "Use --search-tag to find packages by category",
        ),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining(
          "Use --custom-rules to load your own migration rules",
        ),
      )
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining("Use --verbose for detailed output"),
      )
    })
  })
})
