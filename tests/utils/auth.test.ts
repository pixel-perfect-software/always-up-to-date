/**
 * Tests for auth.ts utilities
 */
import { AuthService, getGitHubToken, AuthConfig } from "../../src/utils/auth";
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs";
import { execSync } from "child_process";

// Mock dependencies
jest.mock("fs");
jest.mock("child_process");
jest.mock("../../src/utils/logger");

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>;
const mockReadFileSync = readFileSync as jest.MockedFunction<
  typeof readFileSync
>;
const mockWriteFileSync = writeFileSync as jest.MockedFunction<
  typeof writeFileSync
>;
const mockAppendFileSync = appendFileSync as jest.MockedFunction<
  typeof appendFileSync
>;
const mockExecSync = execSync as jest.MockedFunction<typeof execSync>;

// Mock @octokit/rest
jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    request: jest.fn().mockResolvedValue({ data: { login: "testuser" } }),
  })),
}));

describe("AuthService", () => {
  let authService: AuthService;
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    authService = AuthService.getInstance();
    authService.clearCache();
    originalEnv = { ...process.env };
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
    jest.resetAllMocks();
  });

  describe("getInstance", () => {
    it("should return a singleton instance", () => {
      const instance1 = AuthService.getInstance();
      const instance2 = AuthService.getInstance();
      expect(instance1).toBe(instance2);
    });
  });

  describe("getGitHubToken", () => {
    it("should return manual token with highest priority", async () => {
      const manualToken = "ghp_manual_token";
      const result = await authService.getGitHubToken(manualToken);

      expect(result).toEqual({
        token: manualToken,
        provider: "manual",
      });
    });

    it("should return cached token when available", async () => {
      const manualToken = "ghp_manual_token";
      await authService.getGitHubToken(manualToken);

      // Second call should return cached result
      const result = await authService.getGitHubToken();
      expect(result).toEqual({
        token: manualToken,
        provider: "manual",
      });
    });

    it("should fall back to environment file token", async () => {
      const envToken = "ghp_env_file_token";
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(
        `GITHUB_TOKEN=${envToken}\nOTHER_VAR=value`
      );

      const result = await authService.getGitHubToken();

      expect(result).toEqual({
        token: envToken,
        provider: "config",
      });
    });

    it("should handle quoted tokens in env files", async () => {
      const envToken = "ghp_quoted_token";
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockReturnValue(`GITHUB_TOKEN="${envToken}"`);

      const result = await authService.getGitHubToken();

      expect(result).toEqual({
        token: envToken,
        provider: "config",
      });
    });

    it("should fall back to system environment variable", async () => {
      const systemToken = "ghp_system_token";
      process.env.GITHUB_TOKEN = systemToken;
      mockExistsSync.mockReturnValue(false);

      const result = await authService.getGitHubToken();

      expect(result).toEqual({
        token: systemToken,
        provider: "env",
      });
    });

    it("should try git credentials as last resort", async () => {
      const gitToken = "ghp_git_token";
      mockExistsSync.mockReturnValue(false);
      delete process.env.GITHUB_TOKEN;

      mockExecSync
        .mockReturnValueOnce("manager-core") // credential helper
        .mockReturnValueOnce(
          `protocol=https\nhost=github.com\npassword=${gitToken}\n`
        ); // git credential fill

      const result = await authService.getGitHubToken();

      expect(result).toEqual({
        token: gitToken,
        provider: "env",
      });
    });

    it("should return empty config when no token found", async () => {
      mockExistsSync.mockReturnValue(false);
      delete process.env.GITHUB_TOKEN;
      mockExecSync.mockImplementation(() => {
        throw new Error("Command failed");
      });

      const result = await authService.getGitHubToken();

      expect(result).toEqual({
        provider: "manual",
      });
    });
  });

  describe("validateToken", () => {
    it("should return true for valid token", async () => {
      const validToken = "ghp_valid_token";
      const result = await authService.validateToken(validToken);
      expect(result).toBe(true);
    });

    it("should return false for invalid token", async () => {
      const { Octokit } = await import("@octokit/rest");
      const mockOctokit = Octokit as jest.MockedClass<typeof Octokit>;
      mockOctokit.mockImplementation(
        () =>
          ({
            request: jest.fn().mockRejectedValue(new Error("Unauthorized")),
          } as any)
      );

      const invalidToken = "ghp_invalid_token";
      const result = await authService.validateToken(invalidToken);
      expect(result).toBe(false);
    });
  });

  describe("clearCache", () => {
    it("should clear cached authentication", async () => {
      const manualToken = "ghp_manual_token";
      await authService.getGitHubToken(manualToken);

      authService.clearCache();

      // Should not return cached result after clearing
      process.env.GITHUB_TOKEN = "ghp_system_token";
      const result = await authService.getGitHubToken();
      expect(result.token).toBe("ghp_system_token");
    });
  });

  describe("VS Code integration", () => {
    it("should detect VS Code environment", async () => {
      process.env.VSCODE_PID = "12345";
      mockExistsSync.mockReturnValue(false);
      delete process.env.GITHUB_TOKEN;

      const result = await authService.getGitHubToken();
      expect(result.provider).toBe("manual");
    });

    it("should handle VS Code config paths on macOS", async () => {
      const originalPlatform = process.platform;
      Object.defineProperty(process, "platform", { value: "darwin" });

      process.env.VSCODE_PID = "12345";
      process.env.HOME = "/Users/test";
      mockExistsSync.mockReturnValue(false);
      delete process.env.GITHUB_TOKEN;

      await authService.getGitHubToken();

      Object.defineProperty(process, "platform", { value: originalPlatform });
    });
  });

  describe("error handling", () => {
    it("should handle file read errors gracefully", async () => {
      mockExistsSync.mockReturnValue(true);
      mockReadFileSync.mockImplementation(() => {
        throw new Error("Permission denied");
      });
      delete process.env.GITHUB_TOKEN;

      const result = await authService.getGitHubToken();
      expect(result.provider).toBe("manual");
    });

    it("should handle git command errors gracefully", async () => {
      mockExistsSync.mockReturnValue(false);
      delete process.env.GITHUB_TOKEN;
      mockExecSync.mockImplementation(() => {
        throw new Error("Git not found");
      });

      const result = await authService.getGitHubToken();
      expect(result.provider).toBe("manual");
    });
  });
});

describe("getGitHubToken function", () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = { ...process.env };
    AuthService.getInstance().clearCache();
    jest.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it("should return token when available", async () => {
    const token = "ghp_test_token";
    process.env.GITHUB_TOKEN = token;

    const result = await getGitHubToken();
    expect(result).toBe(token);
  });

  it("should return null when no token available", async () => {
    delete process.env.GITHUB_TOKEN;
    mockExistsSync.mockReturnValue(false);
    mockExecSync.mockImplementation(() => {
      throw new Error("No git");
    });

    // Mock @inquirer/prompts to avoid interactive prompts in tests
    jest.doMock("@inquirer/prompts", () => ({
      confirm: jest.fn().mockResolvedValue(false),
    }));

    const result = await getGitHubToken();
    expect(result).toBeNull();
  });

  it("should use manual token when provided", async () => {
    const manualToken = "ghp_manual_token";
    const result = await getGitHubToken(manualToken);
    expect(result).toBe(manualToken);
  });
});
