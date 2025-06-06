/**
 * Tests for config.ts utilities
 */
import {
  ConfigManager,
  AlwaysUpToDateConfig,
  UpdateStrategy,
  ScheduleConfig,
} from "../../src/utils/config"
import { ConfigurationError } from "../../src/utils/errors"
import { existsSync, readFileSync, writeFileSync } from "fs"
import { join } from "path"

// Mock dependencies
jest.mock("fs")
jest.mock("../../src/utils/logger")

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>
const mockReadFileSync = readFileSync as jest.MockedFunction<
  typeof readFileSync
>
const mockWriteFileSync = writeFileSync as jest.MockedFunction<
  typeof writeFileSync
>

describe("ConfigManager", () => {
  let configManager: ConfigManager
  const testProjectPath = "/test/project"
  const configPath = join(testProjectPath, ".alwaysuptodate.json")

  beforeEach(() => {
    jest.clearAllMocks()
  })

  afterEach(() => {
    jest.resetAllMocks()
  })

  describe("constructor and loadConfig", () => {
    it("should load default config when no config file exists", () => {
      mockExistsSync.mockReturnValue(false)

      configManager = new ConfigManager(testProjectPath)
      const config = configManager.getConfig()

      expect(config.autoUpdate).toBe(false)
      expect(config.createPRs).toBe(false)
      expect(config.defaultUpdateStrategy).toBe("minor")
      expect(config.baseBranch).toBe("main")
      expect(config.allowMajorUpdates).toBe(false)
      expect(config.batchSize).toBe(10)
    })

    it("should merge user config with defaults when config file exists", () => {
      const userConfig = {
        autoUpdate: true,
        createPRs: true,
        ignoredPackages: ["test-package"],
        defaultUpdateStrategy: "patch" as UpdateStrategy,
      }

      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(JSON.stringify(userConfig))

      configManager = new ConfigManager(testProjectPath)
      const config = configManager.getConfig()

      expect(config.autoUpdate).toBe(true)
      expect(config.createPRs).toBe(true)
      expect(config.ignoredPackages).toEqual(["test-package"])
      expect(config.defaultUpdateStrategy).toBe("patch")
      expect(config.baseBranch).toBe("main") // Should keep default for non-specified values
    })

    it("should throw ConfigurationError when config file is invalid JSON", () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue("invalid json{")

      expect(() => new ConfigManager(testProjectPath)).toThrow(
        ConfigurationError,
      )
    })

    it("should throw ConfigurationError when file read fails", () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockImplementation(() => {
        throw new Error("Permission denied")
      })

      expect(() => new ConfigManager(testProjectPath)).toThrow(
        ConfigurationError,
      )
    })
  })

  describe("getConfig", () => {
    it("should return a copy of the config", () => {
      mockExistsSync.mockReturnValue(false)
      configManager = new ConfigManager(testProjectPath)

      const config1 = configManager.getConfig()
      const config2 = configManager.getConfig()

      expect(config1).toEqual(config2)
      expect(config1).not.toBe(config2) // Should be different objects
    })
  })

  describe("updateConfig", () => {
    it("should update config with partial updates", () => {
      mockExistsSync.mockReturnValue(false)
      configManager = new ConfigManager(testProjectPath)

      const updates = {
        autoUpdate: true,
        batchSize: 5,
      }

      configManager.updateConfig(updates)
      const config = configManager.getConfig()

      expect(config.autoUpdate).toBe(true)
      expect(config.batchSize).toBe(5)
      expect(config.createPRs).toBe(false) // Should preserve other values
    })
  })

  describe("shouldIgnorePackage", () => {
    beforeEach(() => {
      const userConfig = {
        ignoredPackages: ["ignored-package", "@types/node"],
      }

      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(JSON.stringify(userConfig))
      configManager = new ConfigManager(testProjectPath)
    })

    it("should return true for ignored packages", () => {
      expect(configManager.shouldIgnorePackage("ignored-package")).toBe(true)
      expect(configManager.shouldIgnorePackage("@types/node")).toBe(true)
    })

    it("should return false for non-ignored packages", () => {
      expect(configManager.shouldIgnorePackage("allowed-package")).toBe(false)
    })
  })

  describe("shouldAllowMajorUpdate", () => {
    it("should return false by default", () => {
      mockExistsSync.mockReturnValue(false)
      configManager = new ConfigManager(testProjectPath)

      expect(configManager.shouldAllowMajorUpdate()).toBe(false)
    })

    it("should return true when enabled", () => {
      const userConfig = { allowMajorUpdates: true }
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(JSON.stringify(userConfig))
      configManager = new ConfigManager(testProjectPath)

      expect(configManager.shouldAllowMajorUpdate()).toBe(true)
    })
  })

  describe("getUpdateStrategyForPackage", () => {
    beforeEach(() => {
      const userConfig = {
        defaultUpdateStrategy: "minor" as UpdateStrategy,
        packageRules: [
          {
            name: "react",
            updateStrategy: "patch" as UpdateStrategy,
          },
          {
            name: "@types/*",
            updateStrategy: "major" as UpdateStrategy,
          },
        ],
      }

      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(JSON.stringify(userConfig))
      configManager = new ConfigManager(testProjectPath)
    })

    it("should return package-specific strategy when rule exists", () => {
      expect(configManager.getUpdateStrategyForPackage("react")).toBe("patch")
    })

    it("should return default strategy when no rule exists", () => {
      expect(configManager.getUpdateStrategyForPackage("unknown-package")).toBe(
        "minor",
      )
    })

    it("should match wildcard patterns", () => {
      expect(configManager.getUpdateStrategyForPackage("@types/node")).toBe(
        "major",
      )
      expect(configManager.getUpdateStrategyForPackage("@types/react")).toBe(
        "major",
      )
    })
  })

  describe("shouldAutoUpdatePackage", () => {
    beforeEach(() => {
      const userConfig = {
        autoUpdate: false,
        packageRules: [
          {
            name: "auto-package",
            updateStrategy: "patch" as UpdateStrategy,
            autoUpdate: true,
          },
          {
            name: "manual-package",
            updateStrategy: "patch" as UpdateStrategy,
            autoUpdate: false,
          },
        ],
      }

      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(JSON.stringify(userConfig))
      configManager = new ConfigManager(testProjectPath)
    })

    it("should return package-specific autoUpdate setting when available", () => {
      expect(configManager.shouldAutoUpdatePackage("auto-package")).toBe(true)
      expect(configManager.shouldAutoUpdatePackage("manual-package")).toBe(
        false,
      )
    })

    it("should return global autoUpdate setting when no package rule exists", () => {
      expect(configManager.shouldAutoUpdatePackage("unknown-package")).toBe(
        false,
      )
    })
  })

  describe("shouldIgnoreVersion", () => {
    beforeEach(() => {
      const userConfig = {
        packageRules: [
          {
            name: "problematic-package",
            updateStrategy: "patch" as UpdateStrategy,
            ignoredVersions: ["1.0.0-beta.1", "2.0.0-rc.1"],
          },
        ],
      }

      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(JSON.stringify(userConfig))
      configManager = new ConfigManager(testProjectPath)
    })

    it("should return true for ignored versions", () => {
      expect(
        configManager.shouldIgnoreVersion(
          "problematic-package",
          "1.0.0-beta.1",
        ),
      ).toBe(true)
      expect(
        configManager.shouldIgnoreVersion("problematic-package", "2.0.0-rc.1"),
      ).toBe(true)
    })

    it("should return false for non-ignored versions", () => {
      expect(
        configManager.shouldIgnoreVersion("problematic-package", "1.0.0"),
      ).toBe(false)
    })

    it("should return false for packages without ignored versions", () => {
      expect(
        configManager.shouldIgnoreVersion("unknown-package", "1.0.0"),
      ).toBe(false)
    })
  })

  describe("getScheduleConfig", () => {
    it("should return schedule configuration", () => {
      const userConfig = {
        schedule: {
          enabled: true,
          daysOfWeek: [1, 2, 3, 4, 5],
          hour: 9,
          includeWeekends: false,
        } as ScheduleConfig,
      }

      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(JSON.stringify(userConfig))
      configManager = new ConfigManager(testProjectPath)

      const schedule = configManager.getScheduleConfig()
      expect(schedule.enabled).toBe(true)
      expect(schedule.daysOfWeek).toEqual([1, 2, 3, 4, 5])
      expect(schedule.hour).toBe(9)
      expect(schedule.includeWeekends).toBe(false)
    })
  })

  describe("utility methods", () => {
    beforeEach(() => {
      const userConfig = {
        dryRun: true,
        confirmBeforeUpdate: true,
        batchSize: 5,
        parallelUpdates: false,
        createSeparatePRs: true,
      }

      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(JSON.stringify(userConfig))
      configManager = new ConfigManager(testProjectPath)
    })

    it("should return correct dry run setting", () => {
      expect(configManager.isDryRun()).toBe(true)
    })

    it("should return correct confirmation requirement", () => {
      expect(configManager.requiresConfirmation()).toBe(true)
    })

    it("should return correct batch size", () => {
      expect(configManager.getBatchSize()).toBe(5)
    })

    it("should return correct parallel updates setting", () => {
      expect(configManager.isParallelUpdatesEnabled()).toBe(false)
    })

    it("should return correct separate PRs setting", () => {
      expect(configManager.shouldCreateSeparatePRs()).toBe(true)
    })
  })

  describe("pattern matching", () => {
    beforeEach(() => {
      mockExistsSync.mockReturnValue(false)
      configManager = new ConfigManager(testProjectPath)
    })

    it("should match exact package names", () => {
      const userConfig = {
        packageRules: [
          {
            name: "exact-match",
            updateStrategy: "patch" as UpdateStrategy,
          },
        ],
      }

      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(JSON.stringify(userConfig))
      configManager = new ConfigManager(testProjectPath)

      expect(configManager.getUpdateStrategyForPackage("exact-match")).toBe(
        "patch",
      )
    })

    it("should match wildcard patterns", () => {
      const userConfig = {
        packageRules: [
          {
            name: "test-*",
            updateStrategy: "patch" as UpdateStrategy,
          },
        ],
      }

      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(JSON.stringify(userConfig))
      configManager = new ConfigManager(testProjectPath)

      expect(configManager.getUpdateStrategyForPackage("test-package")).toBe(
        "patch",
      )
      expect(configManager.getUpdateStrategyForPackage("test-utils")).toBe(
        "patch",
      )
    })

    it("should match scoped package patterns", () => {
      const userConfig = {
        packageRules: [
          {
            name: "@babel/*",
            updateStrategy: "patch" as UpdateStrategy,
          },
        ],
      }

      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(JSON.stringify(userConfig))
      configManager = new ConfigManager(testProjectPath)

      expect(configManager.getUpdateStrategyForPackage("@babel/core")).toBe(
        "patch",
      )
      expect(
        configManager.getUpdateStrategyForPackage("@babel/preset-env"),
      ).toBe("patch")
    })
  })

  describe("createSampleConfig", () => {
    it("should create a sample configuration file", () => {
      ConfigManager.createSampleConfig(testProjectPath)

      expect(mockWriteFileSync).toHaveBeenCalledWith(
        configPath,
        expect.stringContaining('"autoUpdate": false'),
      )
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        configPath,
        expect.stringContaining('"createPRs": true'),
      )
    })
  })
})
