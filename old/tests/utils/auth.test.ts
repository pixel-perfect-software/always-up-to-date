/**
 * Tests for auth.ts utilities
 */
import { AuthService, getGitHubToken, AuthConfig } from "../../src/utils/auth"
import { existsSync, readFileSync, writeFileSync, appendFileSync } from "fs"
import { execSync } from "child_process"

// Mock dependencies
jest.mock("fs")
jest.mock("child_process")
jest.mock("../../src/utils/logger")

const mockExistsSync = existsSync as jest.MockedFunction<typeof existsSync>
const mockReadFileSync = readFileSync as jest.MockedFunction<
  typeof readFileSync
>
const mockWriteFileSync = writeFileSync as jest.MockedFunction<
  typeof writeFileSync
>
const mockAppendFileSync = appendFileSync as jest.MockedFunction<
  typeof appendFileSync
>
const mockExecSync = execSync as jest.MockedFunction<typeof execSync>

// Mock @octokit/rest
jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn().mockImplementation(() => ({
    request: jest.fn().mockResolvedValue({ data: { login: "testuser" } }),
  })),
}))

// Mock @inquirer/prompts
const mockInput = jest.fn()
const mockConfirm = jest.fn()
jest.mock("@inquirer/prompts", () => ({
  input: mockInput,
  confirm: mockConfirm,
}))

describe("AuthService", () => {
  let authService: AuthService
  let originalEnv: NodeJS.ProcessEnv

  beforeEach(() => {
    authService = AuthService.getInstance()
    authService.clearCache()
    originalEnv = { ...process.env }
    jest.clearAllMocks()
  })

  afterEach(() => {
    process.env = originalEnv
    jest.resetAllMocks()
  })

  describe("getInstance", () => {
    it("should return a singleton instance", () => {
      const instance1 = AuthService.getInstance()
      const instance2 = AuthService.getInstance()
      expect(instance1).toBe(instance2)
    })
  })

  describe("getGitHubToken", () => {
    it("should return manual token with highest priority", async () => {
      const manualToken = "ghp_manual_token"
      const result = await authService.getGitHubToken(manualToken)

      expect(result).toEqual({
        token: manualToken,
        provider: "manual",
      })
    })

    it("should return cached token when available", async () => {
      const manualToken = "ghp_manual_token"
      await authService.getGitHubToken(manualToken)

      // Second call should return cached result
      const result = await authService.getGitHubToken()
      expect(result).toEqual({
        token: manualToken,
        provider: "manual",
      })
    })

    it("should fall back to environment file token", async () => {
      const envToken = "ghp_env_file_token"
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        `GITHUB_TOKEN=${envToken}\nOTHER_VAR=value`,
      )

      const result = await authService.getGitHubToken()

      expect(result).toEqual({
        token: envToken,
        provider: "config",
      })
    })

    it("should handle quoted tokens in env files", async () => {
      const envToken = "ghp_quoted_token"
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(`GITHUB_TOKEN="${envToken}"`)

      const result = await authService.getGitHubToken()

      expect(result).toEqual({
        token: envToken,
        provider: "config",
      })
    })

    it("should fall back to system environment variable", async () => {
      const systemToken = "ghp_system_token"
      process.env.GITHUB_TOKEN = systemToken
      mockExistsSync.mockReturnValue(false)

      const result = await authService.getGitHubToken()

      expect(result).toEqual({
        token: systemToken,
        provider: "env",
      })
    })

    it("should try git credentials as last resort", async () => {
      const gitToken = "ghp_git_token"
      mockExistsSync.mockReturnValue(false)
      delete process.env.GITHUB_TOKEN

      mockExecSync
        .mockReturnValueOnce("manager-core") // credential helper
        .mockReturnValueOnce(
          `protocol=https\nhost=github.com\npassword=${gitToken}\n`,
        ) // git credential fill

      const result = await authService.getGitHubToken()

      expect(result).toEqual({
        token: gitToken,
        provider: "env",
      })
    })

    it("should return empty config when no token found", async () => {
      mockExistsSync.mockReturnValue(false)
      delete process.env.GITHUB_TOKEN
      mockExecSync.mockImplementation(() => {
        throw new Error("Command failed")
      })

      const result = await authService.getGitHubToken()

      expect(result).toEqual({
        provider: "manual",
      })
    })
  })

  describe("validateToken", () => {
    it("should return true for valid token", async () => {
      const validToken = "ghp_valid_token"
      const result = await authService.validateToken(validToken)
      expect(result).toBe(true)
    })

    it("should return false for invalid token", async () => {
      const { Octokit } = await import("@octokit/rest")
      const mockOctokit = Octokit as jest.MockedClass<typeof Octokit>
      mockOctokit.mockImplementation(
        () =>
          ({
            request: jest.fn().mockRejectedValue(new Error("Unauthorized")),
          }) as any,
      )

      const invalidToken = "ghp_invalid_token"
      const result = await authService.validateToken(invalidToken)
      expect(result).toBe(false)
    })

    it("should handle network errors during validation", async () => {
      const { Octokit } = await import("@octokit/rest")
      const mockOctokit = Octokit as jest.MockedClass<typeof Octokit>
      mockOctokit.mockImplementation(
        () =>
          ({
            request: jest.fn().mockRejectedValue(new Error("Network error")),
          }) as any,
      )

      const token = "ghp_network_error_token"
      const result = await authService.validateToken(token)
      expect(result).toBe(false)
    })
  })

  describe("caching behavior", () => {
    it("should not use cached token when manual token is provided", async () => {
      // First, cache a token
      const cachedToken = "ghp_cached_token"
      await authService.getGitHubToken(cachedToken)

      // Then provide a different manual token
      const manualToken = "ghp_manual_override"
      const result = await authService.getGitHubToken(manualToken)

      expect(result).toEqual({
        token: manualToken,
        provider: "manual",
      })
    })

    it("should update cache when new manual token is provided", async () => {
      const firstToken = "ghp_first_token"
      const secondToken = "ghp_second_token"

      await authService.getGitHubToken(firstToken)
      await authService.getGitHubToken(secondToken)

      // Subsequent call without manual token should return the second token
      const result = await authService.getGitHubToken()
      expect(result.token).toBe(secondToken)
    })
  })

  describe("clearCache", () => {
    it("should clear cached authentication", async () => {
      const manualToken = "ghp_manual_token"
      await authService.getGitHubToken(manualToken)

      authService.clearCache()

      // Should not return cached result after clearing
      process.env.GITHUB_TOKEN = "ghp_system_token"
      const result = await authService.getGitHubToken()
      expect(result.token).toBe("ghp_system_token")
    })
  })

  describe("VS Code integration", () => {
    it("should detect VS Code environment", async () => {
      process.env.VSCODE_PID = "12345"
      mockExistsSync.mockReturnValue(false)
      delete process.env.GITHUB_TOKEN

      const result = await authService.getGitHubToken()
      expect(result.provider).toBe("manual")
    })

    it("should handle VS Code config paths on macOS", async () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, "platform", { value: "darwin" })

      process.env.VSCODE_PID = "12345"
      process.env.HOME = "/Users/test"
      mockExistsSync.mockReturnValue(false)
      delete process.env.GITHUB_TOKEN

      await authService.getGitHubToken()

      Object.defineProperty(process, "platform", { value: originalPlatform })
    })

    it("should handle VS Code config paths on Windows", async () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, "platform", { value: "win32" })

      process.env.VSCODE_PID = "12345"
      process.env.HOME = "C:\\Users\\test"
      process.env.USERPROFILE = "C:\\Users\\test"
      mockExistsSync.mockReturnValue(false)
      delete process.env.GITHUB_TOKEN

      await authService.getGitHubToken()

      Object.defineProperty(process, "platform", { value: originalPlatform })
    })

    it("should handle VS Code config paths on Linux", async () => {
      const originalPlatform = process.platform
      Object.defineProperty(process, "platform", { value: "linux" })

      process.env.VSCODE_PID = "12345"
      process.env.HOME = "/home/test"
      mockExistsSync.mockReturnValue(false)
      delete process.env.GITHUB_TOKEN

      await authService.getGitHubToken()

      Object.defineProperty(process, "platform", { value: originalPlatform })
    })

    it("should extract token from VS Code with GitHub authentication enabled", async () => {
      process.env.VSCODE_PID = "12345"
      process.env.HOME = "/Users/test"
      delete process.env.GITHUB_TOKEN

      mockExistsSync
        .mockReturnValueOnce(true) // VS Code config exists
        .mockReturnValueOnce(false) // No .env files

      mockReadFileSync.mockReturnValueOnce(
        JSON.stringify({ "github.gitAuthentication": true }),
      )

      // Mock the git credential extraction
      mockExecSync
        .mockReturnValueOnce("vscode-credential-helper") // git config credential.helper
        .mockReturnValueOnce("manager-core") // credential helper for git credentials
        .mockReturnValueOnce(
          "protocol=https\nhost=github.com\npassword=ghp_vscode_token\n",
        ) // git credential fill

      const result = await authService.getGitHubToken()

      expect(result).toEqual({
        token: "ghp_vscode_token",
        provider: "vscode",
      })
    })

    it("should handle VS Code config with no GitHub authentication", async () => {
      process.env.VSCODE_PID = "12345"
      process.env.HOME = "/Users/test"
      delete process.env.GITHUB_TOKEN

      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        JSON.stringify({ "github.gitAuthentication": false }),
      )

      const result = await authService.getGitHubToken()
      expect(result.provider).toBe("manual")
    })

    it("should handle VS Code config JSON parse errors", async () => {
      process.env.VSCODE_PID = "12345"
      process.env.HOME = "/Users/test"
      delete process.env.GITHUB_TOKEN

      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue("invalid json")

      const result = await authService.getGitHubToken()
      expect(result.provider).toBe("manual")
    })

    it("should skip VS Code detection when not in VS Code environment", async () => {
      delete process.env.VSCODE_PID
      delete process.env.TERM_PROGRAM
      delete process.env.GITHUB_TOKEN

      mockExistsSync.mockReturnValue(false)

      const result = await authService.getGitHubToken()
      expect(result.provider).toBe("manual")
    })

    it("should detect VS Code through TERM_PROGRAM", async () => {
      delete process.env.VSCODE_PID
      process.env.TERM_PROGRAM = "vscode"
      delete process.env.GITHUB_TOKEN

      mockExistsSync.mockReturnValue(false)

      const result = await authService.getGitHubToken()
      expect(result.provider).toBe("manual")
    })
  })

  describe("environment file parsing", () => {
    it("should handle single quoted tokens", async () => {
      const envToken = "ghp_single_quoted_token"
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(`GITHUB_TOKEN='${envToken}'`)

      const result = await authService.getGitHubToken()

      expect(result).toEqual({
        token: envToken,
        provider: "config",
      })
    })

    it("should handle tokens with spaces around equals", async () => {
      const envToken = "ghp_spaced_token"
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(`GITHUB_TOKEN = ${envToken}`)

      const result = await authService.getGitHubToken()

      expect(result).toEqual({
        token: envToken,
        provider: "config",
      })
    })

    it("should handle multiple env files priority", async () => {
      const localToken = "ghp_local_token"
      const envToken = "ghp_env_token"

      delete process.env.GITHUB_TOKEN
      delete process.env.VSCODE_PID
      delete process.env.TERM_PROGRAM

      mockExistsSync
        .mockReturnValueOnce(true) // .env.local exists
        .mockReturnValueOnce(false) // .env checked but we use .env.local

      mockReadFileSync.mockReturnValueOnce(`GITHUB_TOKEN=${localToken}`) // .env.local content

      const result = await authService.getGitHubToken()

      expect(result).toEqual({
        token: localToken,
        provider: "config",
      })
    })

    it("should skip to .env when .env.local doesn't exist", async () => {
      const envToken = "ghp_env_token"

      delete process.env.GITHUB_TOKEN
      delete process.env.VSCODE_PID
      delete process.env.TERM_PROGRAM

      mockExistsSync
        .mockReturnValueOnce(false) // .env.local doesn't exist
        .mockReturnValueOnce(true) // .env exists

      mockReadFileSync.mockReturnValueOnce(`GITHUB_TOKEN=${envToken}`)

      const result = await authService.getGitHubToken()

      expect(result).toEqual({
        token: envToken,
        provider: "config",
      })
    })

    it("should handle env files with no GITHUB_TOKEN", async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(`OTHER_VAR=value\nANOTHER_VAR=value2`)
      delete process.env.GITHUB_TOKEN

      const result = await authService.getGitHubToken()
      expect(result.provider).toBe("manual")
    })

    it("should handle malformed env file lines", async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockReturnValue(
        `GITHUB_TOKEN\nMALFORMED_LINE=\nGITHUB_TOKEN=ghp_valid_token`,
      )

      const result = await authService.getGitHubToken()
      expect(result).toEqual({
        token: "ghp_valid_token",
        provider: "config",
      })
    })
  })

  describe("git credentials", () => {
    it("should handle git credential helper not configured", async () => {
      mockExistsSync.mockReturnValue(false)
      delete process.env.GITHUB_TOKEN

      mockExecSync.mockReturnValueOnce("") // empty credential helper

      const result = await authService.getGitHubToken()
      expect(result.provider).toBe("manual")
    })

    it("should handle git credential fill with no password", async () => {
      mockExistsSync.mockReturnValue(false)
      delete process.env.GITHUB_TOKEN

      mockExecSync
        .mockReturnValueOnce("manager-core") // credential helper
        .mockReturnValueOnce("protocol=https\nhost=github.com\nusername=user\n") // no password

      const result = await authService.getGitHubToken()
      expect(result.provider).toBe("manual")
    })

    it("should handle git credential fill with malformed output", async () => {
      mockExistsSync.mockReturnValue(false)
      delete process.env.GITHUB_TOKEN

      mockExecSync
        .mockReturnValueOnce("manager-core") // credential helper
        .mockReturnValueOnce("malformed output") // malformed output

      const result = await authService.getGitHubToken()
      expect(result.provider).toBe("manual")
    })

    it("should handle git credential fill command failure", async () => {
      mockExistsSync.mockReturnValue(false)
      delete process.env.GITHUB_TOKEN

      mockExecSync
        .mockReturnValueOnce("manager-core") // credential helper
        .mockImplementationOnce(() => {
          throw new Error("git credential fill failed")
        })

      const result = await authService.getGitHubToken()
      expect(result.provider).toBe("manual")
    })
  })

  describe("interactive setup", () => {
    beforeEach(() => {
      // Reset all mocks completely
      jest.clearAllMocks()
      mockInput.mockReset()
      mockConfirm.mockReset()
      mockWriteFileSync.mockReset()
      mockAppendFileSync.mockReset()
      mockExistsSync.mockReset()

      // Reset the auth service cache
      authService.clearCache()

      // Reset Octokit mock to success by default
      const { Octokit } = require("@octokit/rest")
      Octokit.mockImplementation(() => ({
        request: jest.fn().mockResolvedValue({ data: { login: "testuser" } }),
      }))
    })

    it("should complete interactive setup with valid token", async () => {
      const token = "ghp_interactive_token"

      mockConfirm
        .mockResolvedValueOnce(true) // want to enter token manually
        .mockResolvedValueOnce(true) // want to save to .env

      mockInput.mockResolvedValueOnce(token)
      mockExistsSync.mockReturnValue(false) // .env doesn't exist

      const result = await authService.interactiveSetup()

      expect(result).toBe(token)
      expect(mockWriteFileSync).toHaveBeenCalledWith(
        expect.stringContaining(".env"),
        `GITHUB_TOKEN=${token}\n`,
      )
    })

    it("should handle user declining manual token entry", async () => {
      mockConfirm.mockResolvedValueOnce(false) // don't want to enter token manually

      const result = await authService.interactiveSetup()

      expect(result).toBeNull()
    })

    it("should handle invalid token format", async () => {
      const validFormatInvalidToken = "ghp_invalid_api_token"

      // Mock Octokit to reject for this specific token
      const { Octokit } = require("@octokit/rest")
      Octokit.mockImplementation(() => ({
        request: jest.fn().mockRejectedValue(new Error("Unauthorized")),
      }))

      mockConfirm.mockResolvedValueOnce(true) // want to enter token manually
      mockInput.mockResolvedValueOnce(validFormatInvalidToken)

      const result = await authService.interactiveSetup()

      expect(result).toBeNull()
    })

    it("should handle token validation failure", async () => {
      const token = "ghp_invalid_api_token"

      // Mock Octokit to throw error for this specific token
      const { Octokit } = await import("@octokit/rest")
      const mockOctokit = Octokit as jest.MockedClass<typeof Octokit>
      mockOctokit.mockImplementation(
        () =>
          ({
            request: jest.fn().mockRejectedValue(new Error("Unauthorized")),
          }) as any,
      )

      mockConfirm.mockResolvedValueOnce(true) // want to enter token manually
      mockInput.mockResolvedValueOnce(token)

      const result = await authService.interactiveSetup()

      expect(result).toBeNull()
    })

    it("should handle saving token to existing .env file", async () => {
      const token = "ghp_append_token"

      mockConfirm
        .mockResolvedValueOnce(true) // want to enter token manually
        .mockResolvedValueOnce(true) // want to save to .env

      mockInput.mockResolvedValueOnce(token)
      mockExistsSync.mockReturnValue(true) // .env exists

      await authService.interactiveSetup()

      expect(mockAppendFileSync).toHaveBeenCalledWith(
        expect.stringContaining(".env"),
        `\nGITHUB_TOKEN=${token}\n`,
      )
    })

    it("should handle declining to save token to .env", async () => {
      const token = "ghp_no_save_token"

      mockConfirm
        .mockResolvedValueOnce(true) // want to enter token manually
        .mockResolvedValueOnce(false) // don't want to save to .env

      mockInput.mockResolvedValueOnce(token)

      const result = await authService.interactiveSetup()

      expect(result).toBe(token)
      expect(mockWriteFileSync).not.toHaveBeenCalled()
      expect(mockAppendFileSync).not.toHaveBeenCalled()
    })

    it("should handle file system errors when saving token", async () => {
      const token = "ghp_save_error_token"

      mockConfirm
        .mockResolvedValueOnce(true) // want to enter token manually
        .mockResolvedValueOnce(true) // want to save to .env

      mockInput.mockResolvedValueOnce(token)
      mockExistsSync.mockReturnValue(false)
      mockWriteFileSync.mockImplementation(() => {
        throw new Error("Permission denied")
      })

      const result = await authService.interactiveSetup()

      expect(result).toBe(token)
    })

    it("should handle interactive setup errors", async () => {
      mockConfirm.mockRejectedValueOnce(new Error("Inquirer error"))

      const result = await authService.interactiveSetup()

      expect(result).toBeNull()
    })
  })

  describe("error handling", () => {
    it("should handle file read errors gracefully", async () => {
      mockExistsSync.mockReturnValue(true)
      mockReadFileSync.mockImplementation(() => {
        throw new Error("Permission denied")
      })
      delete process.env.GITHUB_TOKEN

      const result = await authService.getGitHubToken()
      expect(result.provider).toBe("manual")
    })

    it("should handle git command errors gracefully", async () => {
      mockExistsSync.mockReturnValue(false)
      delete process.env.GITHUB_TOKEN
      mockExecSync.mockImplementation(() => {
        throw new Error("Git not found")
      })

      const result = await authService.getGitHubToken()
      expect(result.provider).toBe("manual")
    })

    it("should handle git config credential.helper errors", async () => {
      mockExistsSync.mockReturnValue(false)
      delete process.env.GITHUB_TOKEN

      mockExecSync.mockImplementation((command) => {
        if (command === "git config --get credential.helper") {
          throw new Error("Git config error")
        }
        return ""
      })

      const result = await authService.getGitHubToken()
      expect(result.provider).toBe("manual")
    })
  })
})

describe("getGitHubToken function", () => {
  let originalEnv: NodeJS.ProcessEnv
  let authService: AuthService

  beforeEach(() => {
    originalEnv = { ...process.env }
    authService = AuthService.getInstance()
    authService.clearCache()
    jest.clearAllMocks()
    mockConfirm.mockClear()
  })

  afterEach(() => {
    process.env = originalEnv
  })

  it("should return token when available", async () => {
    const token = "ghp_test_token"
    process.env.GITHUB_TOKEN = token

    const result = await getGitHubToken()
    expect(result).toBe(token)
  })

  it("should return null when no token available and user declines setup", async () => {
    delete process.env.GITHUB_TOKEN
    mockExistsSync.mockReturnValue(false)
    mockExecSync.mockImplementation(() => {
      throw new Error("No git")
    })

    mockConfirm.mockResolvedValue(false) // decline setup

    const result = await getGitHubToken()
    expect(result).toBeNull()
  })

  it("should use manual token when provided", async () => {
    const manualToken = "ghp_manual_token"
    const result = await getGitHubToken(manualToken)
    expect(result).toBe(manualToken)
  })

  it("should offer interactive setup when no token found", async () => {
    delete process.env.GITHUB_TOKEN
    mockExistsSync.mockReturnValue(false)
    mockExecSync.mockImplementation(() => {
      throw new Error("No git")
    })

    const setupToken = "ghp_setup_token"
    mockConfirm.mockResolvedValue(true) // accept setup

    // Mock the interactive setup
    jest.spyOn(authService, "interactiveSetup").mockResolvedValue(setupToken)

    const result = await getGitHubToken()
    expect(result).toBe(setupToken)
    expect(authService.interactiveSetup).toHaveBeenCalled()
  })

  it("should handle interactive setup errors gracefully", async () => {
    delete process.env.GITHUB_TOKEN
    mockExistsSync.mockReturnValue(false)
    mockExecSync.mockImplementation(() => {
      throw new Error("No git")
    })

    mockConfirm.mockRejectedValue(new Error("Inquirer not available"))

    const result = await getGitHubToken()
    expect(result).toBeNull()
  })

  it("should return null when interactive setup returns null", async () => {
    delete process.env.GITHUB_TOKEN
    mockExistsSync.mockReturnValue(false)
    mockExecSync.mockImplementation(() => {
      throw new Error("No git")
    })

    mockConfirm.mockResolvedValue(true) // accept setup
    jest.spyOn(authService, "interactiveSetup").mockResolvedValue(null)

    const result = await getGitHubToken()
    expect(result).toBeNull()
  })
})
