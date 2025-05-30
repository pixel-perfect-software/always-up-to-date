/**
 * Tests for errors.ts utilities
 */
import {
  AlwaysUpToDateError,
  PackageManagerError,
  GitError,
  NetworkError,
  ConfigurationError,
  DependencyError,
  wrapError,
  withRetry,
} from "../../src/utils/errors";

describe("Error Classes", () => {
  describe("AlwaysUpToDateError", () => {
    it("should create error with message and code", () => {
      const error = new AlwaysUpToDateError("Test message", "TEST_CODE");

      expect(error.message).toBe("Test message");
      expect(error.code).toBe("TEST_CODE");
      expect(error.name).toBe("AlwaysUpToDateError");
      expect(error.originalError).toBeUndefined();
    });

    it("should create error with original error", () => {
      const originalError = new Error("Original error");
      const error = new AlwaysUpToDateError(
        "Test message",
        "TEST_CODE",
        originalError
      );

      expect(error.originalError).toBe(originalError);
    });
  });

  describe("PackageManagerError", () => {
    it("should create package manager specific error", () => {
      const error = new PackageManagerError("NPM failed", "npm");

      expect(error.message).toBe("NPM failed");
      expect(error.code).toBe("PACKAGE_MANAGER_ERROR");
      expect(error.packageManager).toBe("npm");
      expect(error.name).toBe("PackageManagerError");
    });

    it("should include original error", () => {
      const originalError = new Error("Command failed");
      const error = new PackageManagerError("NPM failed", "npm", originalError);

      expect(error.originalError).toBe(originalError);
    });
  });

  describe("GitError", () => {
    it("should create git specific error", () => {
      const error = new GitError("Git command failed");

      expect(error.message).toBe("Git command failed");
      expect(error.code).toBe("GIT_ERROR");
      expect(error.name).toBe("GitError");
    });
  });

  describe("NetworkError", () => {
    it("should create network specific error", () => {
      const error = new NetworkError("Network request failed");

      expect(error.message).toBe("Network request failed");
      expect(error.code).toBe("NETWORK_ERROR");
      expect(error.name).toBe("NetworkError");
    });
  });

  describe("ConfigurationError", () => {
    it("should create configuration specific error", () => {
      const error = new ConfigurationError("Invalid config");

      expect(error.message).toBe("Invalid config");
      expect(error.code).toBe("CONFIGURATION_ERROR");
      expect(error.name).toBe("ConfigurationError");
    });
  });

  describe("DependencyError", () => {
    it("should create dependency specific error", () => {
      const error = new DependencyError("Package not found", "react");

      expect(error.message).toBe("Package not found");
      expect(error.code).toBe("DEPENDENCY_ERROR");
      expect(error.packageName).toBe("react");
      expect(error.name).toBe("DependencyError");
    });
  });
});

describe("wrapError", () => {
  const context = "Test operation";

  it("should return existing AlwaysUpToDateError unchanged", () => {
    const originalError = new AlwaysUpToDateError("Original", "ORIGINAL_CODE");
    const wrappedError = wrapError(originalError, context);

    expect(wrappedError).toBe(originalError);
  });

  it("should wrap git-related errors as GitError", () => {
    const originalError = new Error("git command failed");
    const wrappedError = wrapError(originalError, context);

    expect(wrappedError).toBeInstanceOf(GitError);
    expect(wrappedError.message).toBe(`${context}: git command failed`);
    expect(wrappedError.originalError).toBe(originalError);
  });

  it("should wrap network-related errors as NetworkError", () => {
    const networkError = new Error("network timeout");
    const wrappedError = wrapError(networkError, context);

    expect(wrappedError).toBeInstanceOf(NetworkError);
    expect(wrappedError.message).toBe(`${context}: network timeout`);
  });

  it("should wrap fetch-related errors as NetworkError", () => {
    const fetchError = new Error("fetch failed");
    const wrappedError = wrapError(fetchError, context);

    expect(wrappedError).toBeInstanceOf(NetworkError);
    expect(wrappedError.message).toBe(`${context}: fetch failed`);
  });

  it("should wrap npm-related errors as PackageManagerError", () => {
    const npmError = new Error("npm install failed");
    const wrappedError = wrapError(npmError, context);

    expect(wrappedError).toBeInstanceOf(PackageManagerError);
    expect(wrappedError.message).toBe(`${context}: npm install failed`);
    expect((wrappedError as PackageManagerError).packageManager).toBe(
      "unknown"
    );
  });

  it("should wrap yarn-related errors as PackageManagerError", () => {
    const yarnError = new Error("yarn add failed");
    const wrappedError = wrapError(yarnError, context);

    expect(wrappedError).toBeInstanceOf(PackageManagerError);
    expect(wrappedError.message).toBe(`${context}: yarn add failed`);
  });

  it("should wrap pnpm-related errors as PackageManagerError", () => {
    const pnpmError = new Error("pnpm install failed");
    const wrappedError = wrapError(pnpmError, context);

    expect(wrappedError).toBeInstanceOf(PackageManagerError);
    expect(wrappedError.message).toBe(`${context}: pnpm install failed`);
  });

  it("should wrap unknown errors as AlwaysUpToDateError", () => {
    const unknownError = new Error("unknown error");
    const wrappedError = wrapError(unknownError, context);

    expect(wrappedError).toBeInstanceOf(AlwaysUpToDateError);
    expect(wrappedError.message).toBe(`${context}: unknown error`);
    expect(wrappedError.code).toBe("UNKNOWN_ERROR");
    expect(wrappedError.originalError).toBe(unknownError);
  });
});

describe("withRetry", () => {
  it("should return result on first success", async () => {
    const successFn = jest.fn().mockResolvedValue("success");

    const result = await withRetry(successFn, 3, 100);

    expect(result).toBe("success");
    expect(successFn).toHaveBeenCalledTimes(1);
  });

  it("should retry on failure and return result on success", async () => {
    const retryFn = jest
      .fn()
      .mockRejectedValueOnce(new Error("First failure"))
      .mockRejectedValueOnce(new Error("Second failure"))
      .mockResolvedValueOnce("success");

    const result = await withRetry(retryFn, 3, 100);

    expect(result).toBe("success");
    expect(retryFn).toHaveBeenCalledTimes(3);
  });

  it("should throw error after all retries exhausted", async () => {
    const failureFn = jest
      .fn()
      .mockRejectedValue(new Error("Persistent failure"));

    await expect(withRetry(failureFn, 3, 100)).rejects.toThrow(
      "Persistent failure"
    );
    expect(failureFn).toHaveBeenCalledTimes(3);
  });

  it("should wait increasing delays between retries", async () => {
    const startTime = Date.now();
    const failureFn = jest.fn().mockRejectedValue(new Error("Always fails"));

    try {
      await withRetry(failureFn, 3, 100);
    } catch (error) {
      // Expected to fail
    }

    const endTime = Date.now();
    const elapsed = endTime - startTime;

    // Should wait at least 100ms + 200ms = 300ms (delays are multiplied by attempt number)
    expect(elapsed).toBeGreaterThanOrEqual(290); // Allow some tolerance
    expect(failureFn).toHaveBeenCalledTimes(3);
  });

  it("should use default values when not specified", async () => {
    const failureFn = jest.fn().mockRejectedValue(new Error("Always fails"));

    try {
      await withRetry(failureFn);
    } catch (error) {
      // Expected to fail
    }

    expect(failureFn).toHaveBeenCalledTimes(3); // Default retries
  });

  it("should handle async functions that throw synchronously", async () => {
    const syncThrowFn = jest.fn().mockImplementation(() => {
      throw new Error("Synchronous error");
    });

    await expect(withRetry(syncThrowFn, 2, 50)).rejects.toThrow(
      "Synchronous error"
    );
    expect(syncThrowFn).toHaveBeenCalledTimes(2);
  });

  it("should handle functions that return rejected promises", async () => {
    const rejectedPromiseFn = jest
      .fn()
      .mockReturnValue(Promise.reject(new Error("Rejected promise")));

    await expect(withRetry(rejectedPromiseFn, 2, 50)).rejects.toThrow(
      "Rejected promise"
    );
    expect(rejectedPromiseFn).toHaveBeenCalledTimes(2);
  });

  it("should preserve error types through retries", async () => {
    const customError = new ConfigurationError("Custom config error");
    const failureFn = jest.fn().mockRejectedValue(customError);

    try {
      await withRetry(failureFn, 2, 50);
    } catch (error) {
      expect(error).toBe(customError);
      expect(error).toBeInstanceOf(ConfigurationError);
    }
  });
});
