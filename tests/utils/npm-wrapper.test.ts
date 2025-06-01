import { exec } from "child_process";
import { readFileSync } from "fs";
import npmWrapper from "../../src/utils/npm-wrapper";

// Mock the child_process and fs modules
jest.mock("child_process");
jest.mock("fs");

const mockedExec = exec as jest.MockedFunction<typeof exec>;
const mockedReadFileSync = readFileSync as jest.MockedFunction<
  typeof readFileSync
>;

describe("NpmWrapper", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe("install", () => {
    it("should install a package without version", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(null, { stdout: "installed", stderr: "" });
        return {} as any;
      });

      await npmWrapper.install("lodash");

      expect(mockedExec).toHaveBeenCalledWith(
        "npm install lodash",
        {},
        expect.any(Function)
      );
    });

    it("should install a package with specific version", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(null, { stdout: "installed", stderr: "" });
        return {} as any;
      });

      await npmWrapper.install("lodash", "4.17.21");

      expect(mockedExec).toHaveBeenCalledWith(
        "npm install lodash@4.17.21",
        {},
        expect.any(Function)
      );
    });

    it("should handle installation errors", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(new Error("Installation failed"), null);
        return {} as any;
      });

      await expect(npmWrapper.install("invalid-package")).rejects.toThrow(
        'Error executing command "npm install invalid-package": Installation failed'
      );
    });
  });

  describe("uninstall", () => {
    it("should uninstall a package", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(null, { stdout: "uninstalled", stderr: "" });
        return {} as any;
      });

      await npmWrapper.uninstall("lodash");

      expect(mockedExec).toHaveBeenCalledWith(
        "npm uninstall lodash",
        {},
        expect.any(Function)
      );
    });

    it("should handle uninstallation errors", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(new Error("Uninstallation failed"), null);
        return {} as any;
      });

      await expect(
        npmWrapper.uninstall("non-existent-package")
      ).rejects.toThrow(
        'Error executing command "npm uninstall non-existent-package": Uninstallation failed'
      );
    });
  });

  describe("checkOutdated", () => {
    it("should return outdated packages information", async () => {
      const outdatedOutput = JSON.stringify({
        lodash: {
          current: "4.17.20",
          wanted: "4.17.21",
          latest: "4.17.21",
        },
      });

      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(null, { stdout: outdatedOutput, stderr: "" });
        return {} as any;
      });

      const result = await npmWrapper.checkOutdated();

      expect(mockedExec).toHaveBeenCalledWith(
        "npm outdated --json",
        {},
        expect.any(Function)
      );
      expect(result).toBe(outdatedOutput);
    });

    it("should handle check outdated errors", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(new Error("Command failed"), null);
        return {} as any;
      });

      await expect(npmWrapper.checkOutdated()).rejects.toThrow(
        'Error executing command "npm outdated --json": Command failed'
      );
    });
  });

  describe("getDependencies", () => {
    it("should get dependencies from package.json", async () => {
      const mockPackageJson = JSON.stringify({
        dependencies: {
          lodash: "^4.17.21",
          express: "^4.18.0",
        },
        devDependencies: {
          jest: "^29.0.0",
          typescript: "^4.8.0",
        },
      });

      mockedReadFileSync.mockReturnValue(mockPackageJson);

      const result = await npmWrapper.getDependencies("/path/to/project");

      expect(mockedReadFileSync).toHaveBeenCalledWith(
        "/path/to/project/package.json",
        "utf8"
      );
      expect(result).toEqual({
        lodash: "^4.17.21",
        express: "^4.18.0",
        jest: "^29.0.0",
        typescript: "^4.8.0",
      });
    });

    it("should handle missing dependencies or devDependencies", async () => {
      const mockPackageJson = JSON.stringify({
        name: "test-package",
        version: "1.0.0",
      });

      mockedReadFileSync.mockReturnValue(mockPackageJson);

      const result = await npmWrapper.getDependencies("/path/to/project");

      expect(result).toEqual({});
    });

    it("should handle package.json read errors", async () => {
      mockedReadFileSync.mockImplementation(() => {
        throw new Error("File not found");
      });

      await expect(npmWrapper.getDependencies("/invalid/path")).rejects.toThrow(
        "File not found"
      );
    });
  });

  describe("updateDependency", () => {
    it("should update a dependency to a specific version", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(null, { stdout: "updated", stderr: "" });
        return {} as any;
      });

      await npmWrapper.updateDependency(
        "/path/to/project",
        "lodash",
        "4.17.21"
      );

      expect(mockedExec).toHaveBeenCalledWith(
        "npm install lodash@4.17.21 --save-exact",
        { cwd: "/path/to/project" },
        expect.any(Function)
      );
    });

    it("should handle update errors", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(new Error("Update failed"), null);
        return {} as any;
      });

      await expect(
        npmWrapper.updateDependency(
          "/path/to/project",
          "invalid-package",
          "1.0.0"
        )
      ).rejects.toThrow(
        'Error executing command "npm install invalid-package@1.0.0 --save-exact": Update failed'
      );
    });
  });

  describe("audit", () => {
    it("should return audit results when no vulnerabilities found", async () => {
      const auditOutput = JSON.stringify({
        vulnerabilities: {},
        metadata: {
          vulnerabilities: {
            total: 0,
          },
        },
      });

      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(null, { stdout: auditOutput, stderr: "" });
        return {} as any;
      });

      const result = await npmWrapper.audit();

      expect(mockedExec).toHaveBeenCalledWith(
        "npm audit --json",
        {},
        expect.any(Function)
      );
      expect(result).toEqual(JSON.parse(auditOutput));
    });

    it("should return audit results when vulnerabilities are found", async () => {
      const auditOutput = JSON.stringify({
        vulnerabilities: {
          lodash: {
            severity: "high",
            title: "Prototype Pollution",
          },
        },
        metadata: {
          vulnerabilities: {
            total: 1,
          },
        },
      });

      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        const error: any = new Error("Command failed");
        error.stdout = auditOutput;
        cb(error, null);
        return {} as any;
      });

      const result = await npmWrapper.audit();

      expect(result).toEqual(JSON.parse(auditOutput));
    });

    it("should handle audit errors without stdout", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(new Error("Network error"), null);
        return {} as any;
      });

      await expect(npmWrapper.audit()).rejects.toThrow("Network error");
    });

    it("should handle audit errors with 'Command failed' but no stdout", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        const error: any = new Error("Command failed");
        // No stdout property set
        cb(error, null);
        return {} as any;
      });

      await expect(npmWrapper.audit()).rejects.toThrow("Command failed");
    });

    it("should handle audit errors with 'Command failed' message but no stdout", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        const error: any = new Error("Command failed: npm audit failed");
        // Error has "Command failed" in message but no stdout property
        cb(error, null);
        return {} as any;
      });

      await expect(npmWrapper.audit()).rejects.toThrow(
        "Command failed: npm audit failed"
      );
    });
  });

  describe("getInstalledVersion", () => {
    it("should return the installed version of a package", async () => {
      const mockPackageJson = JSON.stringify({
        name: "lodash",
        version: "4.17.21",
      });

      mockedReadFileSync.mockReturnValue(mockPackageJson);

      const result = await npmWrapper.getInstalledVersion(
        "/path/to/project",
        "lodash"
      );

      expect(mockedReadFileSync).toHaveBeenCalledWith(
        "/path/to/project/node_modules/lodash/package.json",
        "utf8"
      );
      expect(result).toBe("4.17.21");
    });

    it("should return null when package is not installed", async () => {
      mockedReadFileSync.mockImplementation(() => {
        throw new Error("ENOENT: no such file or directory");
      });

      const result = await npmWrapper.getInstalledVersion(
        "/path/to/project",
        "non-existent-package"
      );

      expect(result).toBeNull();
    });
  });

  describe("runCommand (private method testing through public methods)", () => {
    it("should handle stderr warnings gracefully", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(null, {
          stdout: "success",
          stderr:
            "npm WARN deprecated package@1.0.0: This package is deprecated",
        });
        return {} as any;
      });

      const result = await npmWrapper.checkOutdated();

      expect(result).toBe("success");
    });

    it("should throw error for non-warning stderr output", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(null, {
          stdout: "",
          stderr: "Error: Something went wrong",
        });
        return {} as any;
      });

      await expect(npmWrapper.install("test-package")).rejects.toThrow(
        "Error: Something went wrong"
      );
    });

    it("should handle Buffer outputs", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb(null, {
          stdout: Buffer.from("buffer output"),
          stderr: Buffer.from(""),
        });
        return {} as any;
      });

      const result = await npmWrapper.checkOutdated();

      expect(result).toBe("buffer output");
    });

    it("should handle errors with stdout", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        const error: any = new Error("Command failed");
        error.stdout = "partial output";
        error.stderr = "error details";
        cb(error, null);
        return {} as any;
      });

      const result = await npmWrapper.checkOutdated();

      expect(result).toBe("partial output");
    });

    it("should handle unknown errors", async () => {
      mockedExec.mockImplementation((command, options, callback) => {
        const cb = callback as (error: Error | null, result?: any) => void;
        cb("unknown error" as any, null);
        return {} as any;
      });

      await expect(npmWrapper.install("test-package")).rejects.toThrow(
        'Error executing command "npm install test-package": Unknown error'
      );
    });
  });
});
