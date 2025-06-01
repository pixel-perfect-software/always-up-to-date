import { MigrationPluginLoader } from "../../src/services/migration-rules/plugin-loader";
import { MigrationRuleRegistry } from "../../src/services/migration-rules/registry";
import {
  MigrationRuleProvider,
  PackageMigrationInfo,
} from "../../src/services/migration-rules/types";
import { logger } from "../../src/utils/logger";
import * as fs from "fs";
import * as path from "path";

// Mock external dependencies
jest.mock("../../src/utils/logger");
jest.mock("fs");
jest.mock("path");

const mockLogger = logger as jest.Mocked<typeof logger>;
const mockFs = fs as jest.Mocked<typeof fs>;
const mockPath = path as jest.Mocked<typeof path>;

// Create a testable subclass that allows us to mock the import functionality
class TestableMigrationPluginLoader extends MigrationPluginLoader {
  public mockImportModule = jest.fn();

  protected async importModule(filePath: string): Promise<any> {
    return this.mockImportModule(filePath);
  }
}

describe("MigrationPluginLoader", () => {
  let pluginLoader: TestableMigrationPluginLoader;
  let mockRegistry: MigrationRuleRegistry;

  // Mock migration provider for testing
  const mockMigrationInfo: PackageMigrationInfo = {
    name: "test-package",
    rules: [
      {
        fromVersion: "1.0.0",
        toVersion: "2.0.0",
        instructions: "Test migration instructions",
        breakingChanges: ["Breaking change 1"],
        priority: 1,
      },
    ],
    repositoryUrl: "https://github.com/test/test-package",
    changelogUrl: "https://github.com/test/test-package/releases",
    documentationUrl: "https://docs.test-package.com",
    tags: ["testing", "framework"],
  };

  class MockMigrationProvider implements MigrationRuleProvider {
    getPackageName(): string {
      return "test-package";
    }

    getMigrationInfo(): PackageMigrationInfo {
      return mockMigrationInfo;
    }
  }

  beforeEach(() => {
    jest.clearAllMocks();

    // Create mock registry
    mockRegistry = {
      registerProvider: jest.fn(),
      unregisterProvider: jest.fn(),
      getProvider: jest.fn(),
      getAllProviders: jest.fn(),
      getPackageMigrationInfo: jest.fn(),
      listSupportedPackages: jest.fn(),
      searchProvidersByTag: jest.fn(),
    } as any;

    pluginLoader = new TestableMigrationPluginLoader(mockRegistry);

    // Setup default mocks
    mockPath.join.mockImplementation((...args) => args.join("/"));
  });

  describe("Constructor", () => {
    it("should initialize with a registry", () => {
      expect(pluginLoader).toBeInstanceOf(TestableMigrationPluginLoader);
    });
  });

  describe("loadFromDirectory", () => {
    describe("when directory exists", () => {
      beforeEach(() => {
        mockFs.existsSync.mockReturnValue(true);
      });

      it("should load valid TypeScript migration providers", async () => {
        const directory = "/test/directory";
        const files = ["provider1.ts", "provider2.js", "invalid.txt"];

        mockFs.readdirSync.mockReturnValue(files as any);

        // Mock different responses for different files
        pluginLoader.mockImportModule
          .mockResolvedValueOnce({
            TestProvider: MockMigrationProvider,
            InvalidExport: "not a provider",
          })
          .mockResolvedValueOnce({
            InvalidExport: "not a provider",
          });

        await pluginLoader.loadFromDirectory(directory);

        expect(mockFs.existsSync).toHaveBeenCalledWith(directory);
        expect(mockFs.readdirSync).toHaveBeenCalledWith(directory);
        expect(pluginLoader.mockImportModule).toHaveBeenCalledTimes(2); // Called for both .ts and .js files
        expect(mockRegistry.registerProvider).toHaveBeenCalledTimes(1);
        expect(mockLogger.info).toHaveBeenCalledWith(
          "Loaded migration provider from provider1.ts"
        );
      });

      it("should filter only JavaScript and TypeScript files", async () => {
        const directory = "/test/directory";
        const files = [
          "provider.ts",
          "provider.js",
          "config.json",
          "readme.md",
          "image.png",
        ];

        mockFs.readdirSync.mockReturnValue(files as any);
        pluginLoader.mockImportModule.mockResolvedValue({});

        await pluginLoader.loadFromDirectory(directory);

        // Should only attempt to import .ts and .js files
        expect(pluginLoader.mockImportModule).toHaveBeenCalledTimes(2);
        expect(mockPath.join).toHaveBeenCalledWith(directory, "provider.ts");
        expect(mockPath.join).toHaveBeenCalledWith(directory, "provider.js");
      });

      it("should handle empty directory gracefully", async () => {
        const directory = "/empty/directory";
        mockFs.readdirSync.mockReturnValue([] as any);

        await pluginLoader.loadFromDirectory(directory);

        expect(mockFs.existsSync).toHaveBeenCalledWith(directory);
        expect(mockFs.readdirSync).toHaveBeenCalledWith(directory);
        expect(mockRegistry.registerProvider).not.toHaveBeenCalled();
      });

      it("should handle directory with no valid providers", async () => {
        const directory = "/test/directory";
        const files = ["provider.ts"];

        mockFs.readdirSync.mockReturnValue(files as any);
        pluginLoader.mockImportModule.mockResolvedValue({
          invalidExport: "not a provider",
          anotherInvalid: { notAProvider: true },
        });

        await pluginLoader.loadFromDirectory(directory);

        expect(mockRegistry.registerProvider).not.toHaveBeenCalled();
      });

      it("should handle import errors for individual files", async () => {
        const directory = "/test/directory";
        const files = ["working.ts", "broken.ts"];

        mockFs.readdirSync.mockReturnValue(files as any);

        pluginLoader.mockImportModule
          .mockResolvedValueOnce({
            WorkingProvider: MockMigrationProvider,
          })
          .mockRejectedValueOnce(new Error("Import failed"));

        await pluginLoader.loadFromDirectory(directory);

        expect(mockRegistry.registerProvider).toHaveBeenCalledTimes(1);
        expect(mockLogger.warn).toHaveBeenCalledWith(
          "Failed to load migration rules from broken.ts: Error: Import failed"
        );
        expect(mockLogger.info).toHaveBeenCalledWith(
          "Loaded migration provider from working.ts"
        );
      });

      it("should handle fs.readdirSync errors", async () => {
        const directory = "/test/directory";
        const error = new Error("Permission denied");

        mockFs.readdirSync.mockImplementation(() => {
          throw error;
        });

        await pluginLoader.loadFromDirectory(directory);

        expect(mockLogger.error).toHaveBeenCalledWith(
          `Error loading migration plugins: ${error}`
        );
        expect(mockRegistry.registerProvider).not.toHaveBeenCalled();
      });
    });

    describe("when directory does not exist", () => {
      it("should log debug message and return early", async () => {
        const directory = "/nonexistent/directory";
        mockFs.existsSync.mockReturnValue(false);

        await pluginLoader.loadFromDirectory(directory);

        expect(mockFs.existsSync).toHaveBeenCalledWith(directory);
        expect(mockFs.readdirSync).not.toHaveBeenCalled();
        expect(mockLogger.debug).toHaveBeenCalledWith(
          `Migration rules directory not found: ${directory}`
        );
        expect(mockRegistry.registerProvider).not.toHaveBeenCalled();
      });
    });
  });

  describe("loadFromConfig", () => {
    describe("when config file exists", () => {
      beforeEach(() => {
        mockFs.existsSync.mockReturnValue(true);
      });

      it("should load valid migration configuration", async () => {
        const configPath = "/test/config.json";
        const config = {
          migrationRules: {
            "test-package": {
              name: "test-package",
              rules: [
                {
                  fromVersion: "1.0.0",
                  toVersion: "2.0.0",
                  instructions: "Config migration instructions",
                  breakingChanges: ["Config breaking change"],
                },
              ],
            },
            "another-package": {
              name: "another-package",
              rules: [
                {
                  fromVersion: "2.0.0",
                  toVersion: "3.0.0",
                  instructions: "Another migration",
                  breakingChanges: [],
                },
              ],
            },
          },
        };

        mockFs.readFileSync.mockReturnValue(JSON.stringify(config));

        await pluginLoader.loadFromConfig(configPath);

        expect(mockFs.existsSync).toHaveBeenCalledWith(configPath);
        expect(mockFs.readFileSync).toHaveBeenCalledWith(configPath, "utf8");
        expect(mockRegistry.registerProvider).toHaveBeenCalledTimes(2);
        expect(mockLogger.info).toHaveBeenCalledWith(
          "Loaded migration config for test-package"
        );
        expect(mockLogger.info).toHaveBeenCalledWith(
          "Loaded migration config for another-package"
        );
      });

      it("should handle config without migrationRules section", async () => {
        const configPath = "/test/config.json";
        const config = {
          otherConfig: "value",
        };

        mockFs.readFileSync.mockReturnValue(JSON.stringify(config));

        await pluginLoader.loadFromConfig(configPath);

        expect(mockRegistry.registerProvider).not.toHaveBeenCalled();
      });

      it("should handle empty migrationRules object", async () => {
        const configPath = "/test/config.json";
        const config = {
          migrationRules: {},
        };

        mockFs.readFileSync.mockReturnValue(JSON.stringify(config));

        await pluginLoader.loadFromConfig(configPath);

        expect(mockRegistry.registerProvider).not.toHaveBeenCalled();
      });

      it("should handle invalid JSON", async () => {
        const configPath = "/test/invalid.json";
        mockFs.readFileSync.mockReturnValue("{ invalid json }");

        await pluginLoader.loadFromConfig(configPath);

        expect(mockRegistry.registerProvider).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining(
            `Failed to load migration config from ${configPath}`
          )
        );
      });

      it("should handle file read errors", async () => {
        const configPath = "/test/config.json";
        const error = new Error("File read error");

        mockFs.readFileSync.mockImplementation(() => {
          throw error;
        });

        await pluginLoader.loadFromConfig(configPath);

        expect(mockRegistry.registerProvider).not.toHaveBeenCalled();
        expect(mockLogger.warn).toHaveBeenCalledWith(
          `Failed to load migration config from ${configPath}: ${error}`
        );
      });
    });

    describe("when config file does not exist", () => {
      it("should log debug message and return early", async () => {
        const configPath = "/nonexistent/config.json";
        mockFs.existsSync.mockReturnValue(false);

        await pluginLoader.loadFromConfig(configPath);

        expect(mockFs.existsSync).toHaveBeenCalledWith(configPath);
        expect(mockFs.readFileSync).not.toHaveBeenCalled();
        expect(mockLogger.debug).toHaveBeenCalledWith(
          `Migration config not found: ${configPath}`
        );
        expect(mockRegistry.registerProvider).not.toHaveBeenCalled();
      });
    });
  });

  describe("isValidProvider (private method testing through public methods)", () => {
    it("should identify valid provider classes", async () => {
      const directory = "/test/directory";
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(["valid.ts"] as any);

      pluginLoader.mockImportModule.mockResolvedValue({
        ValidProvider: MockMigrationProvider,
      });

      await pluginLoader.loadFromDirectory(directory);

      expect(mockRegistry.registerProvider).toHaveBeenCalledTimes(1);
    });

    it("should reject non-function exports", async () => {
      const directory = "/test/directory";
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(["invalid.ts"] as any);

      pluginLoader.mockImportModule.mockResolvedValue({
        notAFunction: "string value",
        objectExport: { key: "value" },
        numberExport: 42,
      });

      await pluginLoader.loadFromDirectory(directory);

      expect(mockRegistry.registerProvider).not.toHaveBeenCalled();
    });

    it("should reject functions without required prototype methods", async () => {
      const directory = "/test/directory";
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(["invalid.ts"] as any);

      class InvalidProvider {
        // Missing getPackageName and getMigrationInfo methods
        someOtherMethod() {
          return "test";
        }
      }

      pluginLoader.mockImportModule.mockResolvedValue({
        InvalidProvider,
      });

      await pluginLoader.loadFromDirectory(directory);

      expect(mockRegistry.registerProvider).not.toHaveBeenCalled();
    });

    it("should reject functions with incomplete prototype methods", async () => {
      const directory = "/test/directory";
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue(["invalid.ts"] as any);

      class IncompleteProvider {
        getPackageName() {
          return "test";
        }
        // Missing getMigrationInfo method
      }

      pluginLoader.mockImportModule.mockResolvedValue({
        IncompleteProvider,
      });

      await pluginLoader.loadFromDirectory(directory);

      expect(mockRegistry.registerProvider).not.toHaveBeenCalled();
    });
  });

  describe("createProviderFromConfig (tested through loadFromConfig)", () => {
    it("should create providers with correct getPackageName method", async () => {
      const configPath = "/test/config.json";
      const packageName = "custom-package";
      const packageInfo = mockMigrationInfo;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          migrationRules: {
            [packageName]: packageInfo,
          },
        })
      );

      await pluginLoader.loadFromConfig(configPath);

      // Verify the provider was registered
      expect(mockRegistry.registerProvider).toHaveBeenCalledTimes(1);

      // Get the provider that was registered
      const registeredProvider = (mockRegistry.registerProvider as jest.Mock)
        .mock.calls[0][0];
      expect(registeredProvider.getPackageName()).toBe(packageName);
    });

    it("should create providers with correct getMigrationInfo method", async () => {
      const configPath = "/test/config.json";
      const packageName = "custom-package";
      const packageInfo = mockMigrationInfo;

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(
        JSON.stringify({
          migrationRules: {
            [packageName]: packageInfo,
          },
        })
      );

      await pluginLoader.loadFromConfig(configPath);

      // Get the provider that was registered
      const registeredProvider = (mockRegistry.registerProvider as jest.Mock)
        .mock.calls[0][0];
      expect(registeredProvider.getMigrationInfo()).toEqual(packageInfo);
    });
  });

  describe("Integration scenarios", () => {
    it("should handle mixed valid and invalid providers in directory", async () => {
      const directory = "/test/mixed";
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        "valid1.ts",
        "valid2.js",
        "invalid.ts",
      ] as any);

      class AnotherValidProvider implements MigrationRuleProvider {
        getPackageName(): string {
          return "another-valid";
        }
        getMigrationInfo(): PackageMigrationInfo {
          return {
            name: "another-valid",
            rules: [],
          };
        }
      }

      class InvalidProvider {
        wrongMethod() {
          return "invalid";
        }
      }

      pluginLoader.mockImportModule
        .mockResolvedValueOnce({ ValidProvider1: MockMigrationProvider })
        .mockResolvedValueOnce({ ValidProvider2: AnotherValidProvider })
        .mockResolvedValueOnce({ InvalidProvider });

      await pluginLoader.loadFromDirectory(directory);

      expect(mockRegistry.registerProvider).toHaveBeenCalledTimes(2);
      expect(mockLogger.info).toHaveBeenCalledTimes(2);
    });

    it("should handle complex configuration with multiple packages", async () => {
      const configPath = "/test/complex.json";
      const complexConfig = {
        migrationRules: {
          "package-a": {
            name: "package-a",
            rules: [
              {
                fromVersion: "1.0.0",
                toVersion: "2.0.0",
                instructions: "Migration A",
                breakingChanges: ["Breaking A"],
              },
            ],
            tags: ["framework"],
          },
          "package-b": {
            name: "package-b",
            rules: [
              {
                fromVersion: "3.0.0",
                toVersion: "4.0.0",
                instructions: "Migration B",
                breakingChanges: ["Breaking B"],
                automatedFixes: ["Fix B"],
                priority: 2,
              },
            ],
            repositoryUrl: "https://github.com/test/package-b",
            tags: ["testing", "utility"],
          },
        },
        otherConfig: {
          someKey: "someValue",
        },
      };

      mockFs.existsSync.mockReturnValue(true);
      mockFs.readFileSync.mockReturnValue(JSON.stringify(complexConfig));

      await pluginLoader.loadFromConfig(configPath);

      expect(mockRegistry.registerProvider).toHaveBeenCalledTimes(2);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Loaded migration config for package-a"
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Loaded migration config for package-b"
      );

      // Verify the providers were created correctly
      const calls = (mockRegistry.registerProvider as jest.Mock).mock.calls;
      expect(calls[0][0].getPackageName()).toBe("package-a");
      expect(calls[1][0].getPackageName()).toBe("package-b");
      expect(calls[0][0].getMigrationInfo()).toEqual(
        complexConfig.migrationRules["package-a"]
      );
      expect(calls[1][0].getMigrationInfo()).toEqual(
        complexConfig.migrationRules["package-b"]
      );
    });

    it("should handle multiple files with different provider types", async () => {
      const directory = "/test/multiple";
      mockFs.existsSync.mockReturnValue(true);
      mockFs.readdirSync.mockReturnValue([
        "framework.ts",
        "utility.js",
        "testing.ts",
      ] as any);

      class FrameworkProvider implements MigrationRuleProvider {
        getPackageName() {
          return "framework-pkg";
        }
        getMigrationInfo() {
          return { name: "framework-pkg", rules: [] };
        }
      }

      class UtilityProvider implements MigrationRuleProvider {
        getPackageName() {
          return "utility-pkg";
        }
        getMigrationInfo() {
          return { name: "utility-pkg", rules: [] };
        }
      }

      class TestingProvider implements MigrationRuleProvider {
        getPackageName() {
          return "testing-pkg";
        }
        getMigrationInfo() {
          return { name: "testing-pkg", rules: [] };
        }
      }

      pluginLoader.mockImportModule
        .mockResolvedValueOnce({
          FrameworkProvider,
          ExtraExport: "ignored",
        })
        .mockResolvedValueOnce({
          UtilityProvider,
          AnotherExport: { ignored: true },
        })
        .mockResolvedValueOnce({
          TestingProvider,
          invalidExport: "not a provider",
        });

      await pluginLoader.loadFromDirectory(directory);

      expect(mockRegistry.registerProvider).toHaveBeenCalledTimes(3);
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Loaded migration provider from framework.ts"
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Loaded migration provider from utility.js"
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        "Loaded migration provider from testing.ts"
      );
    });
  });
});
