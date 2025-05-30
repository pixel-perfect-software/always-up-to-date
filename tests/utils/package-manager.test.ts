/**
 * Tests for package-manager.ts utilities
 */

// Mock dependencies first before any imports
jest.mock("fs");
jest.mock("child_process");
jest.mock("../../src/utils/logger");

// Mock the promisify function from util
const mockExecPromise = jest.fn();
jest.mock("util", () => ({
  promisify: jest.fn(() => mockExecPromise),
}));

import {
  PackageManagerInterface,
  PackageManagerDetector,
} from "../../src/utils/package-manager";
import { PackageManagerError, NetworkError } from "../../src/utils/errors";
import { existsSync, readFileSync } from "fs";

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<
  typeof readFileSync
>;

describe("PackageManager", () => {
  let packageManager: PackageManagerInterface;
  const testProjectPath = "/test/project";

  beforeEach(() => {
    jest.clearAllMocks();
    mockExecPromise.mockClear();
  });

  afterEach(() => {
    jest.resetAllMocks();
  });

  describe("NpmPackageManager", () => {
    beforeEach(() => {
      packageManager = PackageManagerDetector.create("npm");
    });

    describe("install", () => {
      it("should install package without version", async () => {
        mockExecPromise.mockResolvedValue({ stdout: "installed", stderr: "" });

        await packageManager.install("react");

        expect(mockExecPromise).toHaveBeenCalledWith("npm install react", {});
      });

      it("should install package with specific version", async () => {
        mockExecPromise.mockResolvedValue({ stdout: "installed", stderr: "" });

        await packageManager.install("react", "18.0.0");

        expect(mockExecPromise).toHaveBeenCalledWith(
          "npm install react@18.0.0",
          {}
        );
      });

      it("should throw PackageManagerError on failure", async () => {
        mockExecPromise.mockRejectedValue(new Error("Installation failed"));

        await expect(packageManager.install("react")).rejects.toThrow(
          PackageManagerError
        );
      });

      it("should retry on failure", async () => {
        mockExecPromise
          .mockRejectedValueOnce(new Error("Network error"))
          .mockResolvedValueOnce({ stdout: "installed", stderr: "" });

        await packageManager.install("react");

        expect(mockExecPromise).toHaveBeenCalledTimes(2);
      });
    });

    describe("uninstall", () => {
      it("should uninstall package", async () => {
        mockExecPromise.mockResolvedValue({
          stdout: "uninstalled",
          stderr: "",
        });

        await packageManager.uninstall("react");

        expect(mockExecPromise).toHaveBeenCalledWith("npm uninstall react", {});
      });

      it("should throw PackageManagerError on failure", async () => {
        mockExecPromise.mockRejectedValue(new Error("Uninstall failed"));

        await expect(packageManager.uninstall("react")).rejects.toThrow(
          PackageManagerError
        );
      });
    });

    describe("checkOutdated", () => {
      it("should return outdated packages information", async () => {
        const outdatedOutput =
          '{"react": {"current": "17.0.0", "wanted": "18.0.0"}}';
        mockExecPromise.mockResolvedValue({
          stdout: outdatedOutput,
          stderr: "",
        });

        const result = await packageManager.checkOutdated();

        expect(result).toBe(outdatedOutput);
        expect(mockExecPromise).toHaveBeenCalledWith("npm outdated --json", {});
      });

      it("should retry and throw PackageManagerError on persistent failure", async () => {
        mockExecPromise.mockRejectedValue(new Error("Command failed"));

        await expect(packageManager.checkOutdated()).rejects.toThrow(
          PackageManagerError
        );
        expect(mockExecPromise).toHaveBeenCalledTimes(2); // Initial + 1 retry
      });
    });

    describe("getDependencies", () => {
      it("should return combined dependencies and devDependencies", async () => {
        const packageJson = {
          dependencies: { react: "^18.0.0" },
          devDependencies: { "@types/react": "^18.0.0" },
        };

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(JSON.stringify(packageJson));

        const result = await packageManager.getDependencies(testProjectPath);

        expect(result).toEqual({
          react: "^18.0.0",
          "@types/react": "^18.0.0",
        });
      });

      it("should handle missing devDependencies", async () => {
        const packageJson = {
          dependencies: { react: "^18.0.0" },
        };

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(JSON.stringify(packageJson));

        const result = await packageManager.getDependencies(testProjectPath);

        expect(result).toEqual({ react: "^18.0.0" });
      });

      it("should handle missing dependencies", async () => {
        const packageJson = {
          devDependencies: { "@types/react": "^18.0.0" },
        };

        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(JSON.stringify(packageJson));

        const result = await packageManager.getDependencies(testProjectPath);

        expect(result).toEqual({ "@types/react": "^18.0.0" });
      });

      it("should throw PackageManagerError when package.json not found", async () => {
        mockExistsSync.mockReturnValue(false);

        await expect(
          packageManager.getDependencies(testProjectPath)
        ).rejects.toThrow(PackageManagerError);
      });

      it("should throw PackageManagerError when package.json is invalid", async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue("invalid json");

        await expect(
          packageManager.getDependencies(testProjectPath)
        ).rejects.toThrow(PackageManagerError);
      });
    });

    describe("updateDependency", () => {
      it("should update dependency to specific version", async () => {
        mockExecPromise.mockResolvedValue({ stdout: "updated", stderr: "" });

        await packageManager.updateDependency(
          testProjectPath,
          "react",
          "18.0.0"
        );

        expect(mockExecPromise).toHaveBeenCalledWith(
          "npm install react@18.0.0 --save-exact",
          { cwd: testProjectPath }
        );
      });

      it("should retry and throw PackageManagerError on failure", async () => {
        mockExecPromise.mockRejectedValue(new Error("Update failed"));

        await expect(
          packageManager.updateDependency(testProjectPath, "react", "18.0.0")
        ).rejects.toThrow(PackageManagerError);
        expect(mockExecPromise).toHaveBeenCalledTimes(2);
      });
    });

    describe("audit", () => {
      it("should return audit results as JSON", async () => {
        const auditOutput = { vulnerabilities: { low: 0, high: 0 } };
        mockExecPromise.mockResolvedValue({
          stdout: JSON.stringify(auditOutput),
          stderr: "",
        });

        const result = await packageManager.audit();

        expect(result).toEqual(auditOutput);
        expect(mockExecPromise).toHaveBeenCalledWith("npm audit --json", {});
      });

      it("should handle audit results with vulnerabilities in stdout of failed command", async () => {
        const auditOutput = { vulnerabilities: { low: 2, high: 1 } };
        const error = new Error("Command failed") as any;
        error.stdout = JSON.stringify(auditOutput);
        mockExecPromise.mockRejectedValue(error);

        const result = await packageManager.audit();

        expect(result).toEqual(auditOutput);
      });

      it("should throw PackageManagerError when audit fails with no stdout", async () => {
        mockExecPromise.mockRejectedValue(new Error("Audit failed"));

        await expect(packageManager.audit()).rejects.toThrow(
          PackageManagerError
        );
      });

      it("should throw PackageManagerError when stdout is not valid JSON", async () => {
        const error = new Error("Command failed") as any;
        error.stdout = "invalid json";
        mockExecPromise.mockRejectedValue(error);

        await expect(packageManager.audit()).rejects.toThrow(
          PackageManagerError
        );
      });
    });

    describe("getInstalledVersion", () => {
      it("should return installed package version", async () => {
        const packageJson = { version: "18.0.0" };
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockReturnValue(JSON.stringify(packageJson));

        const result = await packageManager.getInstalledVersion(
          testProjectPath,
          "react"
        );

        expect(result).toBe("18.0.0");
      });

      it("should return null when package not installed", async () => {
        mockExistsSync.mockReturnValue(false);

        const result = await packageManager.getInstalledVersion(
          testProjectPath,
          "react"
        );

        expect(result).toBeNull();
      });

      it("should return null when package.json is invalid", async () => {
        mockExistsSync.mockReturnValue(true);
        mockReadFileSync.mockImplementation(() => {
          throw new Error("Permission denied");
        });

        const result = await packageManager.getInstalledVersion(
          testProjectPath,
          "react"
        );

        expect(result).toBeNull();
      });
    });

    describe("command execution error handling", () => {
      it("should throw PackageManagerError for network-related errors", async () => {
        mockExecPromise.mockRejectedValue(new Error("network timeout"));

        await expect(packageManager.install("react")).rejects.toThrow(
          PackageManagerError
        );
      });

      it("should handle warnings in stderr without throwing", async () => {
        mockExecPromise.mockResolvedValue({
          stdout: "installed",
          stderr: "npm WARN deprecated package",
        });

        await expect(packageManager.install("react")).resolves.not.toThrow();
      });

      it("should throw error for non-warning stderr", async () => {
        mockExecPromise.mockResolvedValue({
          stdout: "installed",
          stderr: "npm ERR! Something went wrong",
        });

        await expect(packageManager.install("react")).rejects.toThrow();
      });
    });
  });

  describe("YarnPackageManager", () => {
    beforeEach(() => {
      packageManager = PackageManagerDetector.create("yarn");
    });

    it("should use yarn commands", async () => {
      mockExecPromise.mockResolvedValue({ stdout: "installed", stderr: "" });

      await packageManager.install("react", "18.0.0");

      expect(mockExecPromise).toHaveBeenCalledWith("yarn add react@18.0.0", {});
    });

    it("should recognize yarn warnings", async () => {
      mockExecPromise.mockResolvedValue({
        stdout: "installed",
        stderr: "warning deprecated package",
      });

      await expect(packageManager.install("react")).resolves.not.toThrow();
    });

    it("should use yarn update command", async () => {
      mockExecPromise.mockResolvedValue({ stdout: "updated", stderr: "" });

      await packageManager.updateDependency(testProjectPath, "react", "18.0.0");

      expect(mockExecPromise).toHaveBeenCalledWith(
        "yarn add react@18.0.0 --exact",
        { cwd: testProjectPath }
      );
    });
  });

  describe("PnpmPackageManager", () => {
    beforeEach(() => {
      packageManager = PackageManagerDetector.create("pnpm");
    });

    it("should use pnpm commands", async () => {
      mockExecPromise.mockResolvedValue({ stdout: "installed", stderr: "" });

      await packageManager.install("react", "18.0.0");

      expect(mockExecPromise).toHaveBeenCalledWith("pnpm add react@18.0.0", {});
    });

    it("should recognize pnpm warnings", async () => {
      mockExecPromise.mockResolvedValue({
        stdout: "installed",
        stderr: "WARN deprecated package",
      });

      await expect(packageManager.install("react")).resolves.not.toThrow();
    });

    it("should use pnpm outdated command with format json", async () => {
      mockExecPromise.mockResolvedValue({ stdout: "{}", stderr: "" });

      await packageManager.checkOutdated();

      expect(mockExecPromise).toHaveBeenCalledWith(
        "pnpm outdated --format json",
        {}
      );
    });
  });
});

describe("PackageManagerDetector", () => {
  const testProjectPath = "/test/project";

  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("detect", () => {
    it("should detect pnpm from lock file", () => {
      mockExistsSync.mockImplementation((path: any) => {
        return String(path).includes("pnpm-lock.yaml");
      });

      const manager = PackageManagerDetector.detect(testProjectPath);
      expect(manager).toBeDefined();
    });

    it("should detect yarn from lock file", () => {
      mockExistsSync.mockImplementation((path: any) => {
        return String(path).includes("yarn.lock");
      });

      const manager = PackageManagerDetector.detect(testProjectPath);
      expect(manager).toBeDefined();
    });

    it("should detect npm from lock file", () => {
      mockExistsSync.mockImplementation((path: any) => {
        return String(path).includes("package-lock.json");
      });

      const manager = PackageManagerDetector.detect(testProjectPath);
      expect(manager).toBeDefined();
    });

    it("should default to npm when no lock file found", () => {
      mockExistsSync.mockReturnValue(false);

      const manager = PackageManagerDetector.detect(testProjectPath);
      expect(manager).toBeDefined();
    });

    it("should prioritize pnpm over yarn and npm", () => {
      mockExistsSync.mockReturnValue(true); // All lock files exist

      const manager = PackageManagerDetector.detect(testProjectPath);
      expect(manager).toBeDefined();
    });
  });

  describe("create", () => {
    it("should create npm package manager", () => {
      const manager = PackageManagerDetector.create("npm");
      expect(manager).toBeDefined();
    });

    it("should create yarn package manager", () => {
      const manager = PackageManagerDetector.create("yarn");
      expect(manager).toBeDefined();
    });

    it("should create pnpm package manager", () => {
      const manager = PackageManagerDetector.create("pnpm");
      expect(manager).toBeDefined();
    });

    it("should handle case insensitive package manager names", () => {
      expect(PackageManagerDetector.create("NPM")).toBeDefined();
      expect(PackageManagerDetector.create("YARN")).toBeDefined();
      expect(PackageManagerDetector.create("PNPM")).toBeDefined();
    });

    it("should throw error for unsupported package manager", () => {
      expect(() => PackageManagerDetector.create("unsupported")).toThrow(
        "Unsupported package manager: unsupported"
      );
    });
  });
});
