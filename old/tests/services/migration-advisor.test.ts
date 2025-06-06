import { MigrationAdvisor } from "../../src/services/migration-advisor"
import {
  MigrationRuleProvider,
  PackageMigrationInfo,
} from "../../src/services/migration-rules"
import { execSync } from "child_process"
import { logger } from "../../src/utils/logger"

// Mock external dependencies
jest.mock("child_process")
jest.mock("../../src/utils/logger")
jest.mock("../../src/utils/auth")
jest.mock("@octokit/rest")

const mockExecSync = execSync as jest.MockedFunction<typeof execSync>
const mockLogger = logger as jest.Mocked<typeof logger>

// Enhanced Octokit mock
const mockOctokit = {
  repos: {
    listReleases: jest.fn(),
    getContent: jest.fn(),
  },
  rest: {
    repos: {},
  },
}

jest.mock("@octokit/rest", () => ({
  Octokit: jest.fn(() => mockOctokit),
}))

describe("Migration Advisor Comprehensive Tests", () => {
  let advisor: MigrationAdvisor

  beforeEach(() => {
    jest.clearAllMocks()
    advisor = new MigrationAdvisor()
  })

  describe("Constructor and Initialization", () => {
    it("should initialize with GitHub token", () => {
      const token = "test-github-token"
      const advisorWithToken = new MigrationAdvisor(token)
      expect(advisorWithToken).toBeInstanceOf(MigrationAdvisor)
    })

    it("should initialize with custom rules path", () => {
      const customPath = "/path/to/custom/rules"
      const advisorWithCustomPath = new MigrationAdvisor(undefined, customPath)
      expect(advisorWithCustomPath).toBeInstanceOf(MigrationAdvisor)
    })

    it("should handle failed custom rules loading gracefully", () => {
      const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation()
      const advisorWithInvalidPath = new MigrationAdvisor(
        undefined,
        "/invalid/path",
      )
      expect(advisorWithInvalidPath).toBeInstanceOf(MigrationAdvisor)
      consoleWarnSpy.mockRestore()
    })
  })

  describe("Built-in Providers", () => {
    it("should load default providers", () => {
      const supportedPackages = advisor.getSupportedPackages()

      expect(supportedPackages).toContain("react")
      expect(supportedPackages).toContain("next")
      expect(supportedPackages).toContain("typescript")
      expect(supportedPackages).toContain("eslint")
      expect(supportedPackages).toContain("prettier")
      expect(supportedPackages).toContain("jest")
    })

    it("should provide migration instructions for React", async () => {
      const instructions = await advisor.getMigrationInstructions(
        "react",
        "17.0.0",
        "18.0.0",
      )

      expect(instructions).toContain("React 18 Migration Guide")
      expect(instructions).toContain("ReactDOM.createRoot")
      expect(instructions).toContain("Automatic Batching")
    })

    it("should provide migration instructions for Next.js", async () => {
      const instructions = await advisor.getMigrationInstructions(
        "next",
        "13.0.0",
        "14.0.0",
      )

      expect(instructions).toContain("Next.js 14 Migration Guide")
      expect(instructions).toContain("App Router")
      expect(instructions).toContain("Server Actions")
    })
  })

  describe("Custom Providers", () => {
    class TestMigrationProvider implements MigrationRuleProvider {
      getPackageName(): string {
        return "test-package"
      }

      getMigrationInfo(): PackageMigrationInfo {
        return {
          name: "test-package",
          tags: ["test", "custom"],
          rules: [
            {
              fromVersion: "1.x.x",
              toVersion: "2.x.x",
              priority: 1,
              instructions: "Test migration instructions",
              breakingChanges: ["API changed"],
              automatedFixes: ["Update imports"],
            },
          ],
          repositoryUrl: "https://github.com/test/test-package",
        }
      }
    }

    it("should register custom providers", () => {
      const customProvider = new TestMigrationProvider()
      advisor.registerCustomProvider(customProvider)

      const supportedPackages = advisor.getSupportedPackages()
      expect(supportedPackages).toContain("test-package")
    })

    it("should provide migration instructions from custom providers", async () => {
      const customProvider = new TestMigrationProvider()
      advisor.registerCustomProvider(customProvider)

      const instructions = await advisor.getMigrationInstructions(
        "test-package",
        "1.0.0",
        "2.0.0",
      )
      expect(instructions).toContain("Test migration instructions")
    })
  })

  describe("Tag Search", () => {
    it("should find providers by tag", () => {
      const frameworkPackages = advisor.searchProvidersByTag("framework")
      expect(frameworkPackages).toContain("react")
      expect(frameworkPackages).toContain("next")
    })

    it("should find testing packages", () => {
      const testingPackages = advisor.searchProvidersByTag("testing")
      expect(testingPackages).toContain("jest")
    })

    it("should find linting packages", () => {
      const lintingPackages = advisor.searchProvidersByTag("linting")
      expect(lintingPackages).toContain("eslint")
      expect(lintingPackages).toContain("prettier")
    })
  })

  describe("Priority Handling", () => {
    class PriorityTestProvider implements MigrationRuleProvider {
      getPackageName(): string {
        return "priority-test"
      }

      getMigrationInfo(): PackageMigrationInfo {
        return {
          name: "priority-test",
          rules: [
            {
              fromVersion: "1.x.x",
              toVersion: "2.x.x",
              priority: 1,
              instructions: "Low priority instruction",
              breakingChanges: [],
            },
            {
              fromVersion: "1.x.x",
              toVersion: "2.x.x",
              priority: 5,
              instructions: "High priority instruction",
              breakingChanges: [],
            },
          ],
        }
      }
    }

    it("should use highest priority rule", async () => {
      const provider = new PriorityTestProvider()
      advisor.registerCustomProvider(provider)

      const instructions = await advisor.getMigrationInstructions(
        "priority-test",
        "1.0.0",
        "2.0.0",
      )
      expect(instructions).toContain("High priority instruction")
    })
  })

  describe("getMigrationInstructions Error Handling", () => {
    it("should return generic instructions when all methods fail", async () => {
      // Mock package repository to return empty result
      mockExecSync.mockImplementation(() => {
        throw new Error("Package not found")
      })

      const instructions = await advisor.getMigrationInstructions(
        "unknown-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
      expect(instructions).toContain("unknown-package")
      expect(instructions).toContain("1.0.0 → 2.0.0")
    })

    it("should handle minor version updates", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("Package not found")
      })

      const instructions = await advisor.getMigrationInstructions(
        "test-package",
        "1.0.0",
        "1.1.0",
      )

      expect(instructions).toContain("minor/patch update")
      expect(instructions).toContain("test-package")
      expect(instructions).toContain("1.0.0 → 1.1.0")
    })

    it("should log errors and fallback to generic instructions", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("Network error")
      })

      const instructions = await advisor.getMigrationInstructions(
        "error-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
      expect(instructions).toContain("error-package")
    })
  })

  describe("Package Repository Information", () => {
    it("should extract GitHub repository from npm package info", async () => {
      const mockPackageInfo = JSON.stringify({
        repository: {
          url: "git+https://github.com/owner/repo.git",
        },
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))

      // Mock GitHub API calls
      mockOctokit.repos.listReleases.mockResolvedValue({
        data: [
          {
            tag_name: "v2.0.0",
            body: "## Breaking Changes\n- Major API changes\n- Migration required",
          },
        ],
      })

      const instructions = await advisor.getMigrationInstructions(
        "github-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("github-package Migration")
      expect(instructions).toContain("Breaking Changes")
    })

    it("should handle string repository format", async () => {
      const mockPackageInfo = JSON.stringify({
        repository: "https://github.com/owner/repo",
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))

      mockOctokit.repos.listReleases.mockResolvedValue({ data: [] })

      const instructions = await advisor.getMigrationInstructions(
        "string-repo-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toBeDefined()
    })

    it("should handle packages without repository information", async () => {
      const mockPackageInfo = JSON.stringify({
        name: "no-repo-package",
        version: "1.0.0",
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))

      const instructions = await advisor.getMigrationInstructions(
        "no-repo-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })

    it("should handle npm command failures gracefully", async () => {
      mockExecSync.mockImplementation(() => {
        throw new Error("npm command failed")
      })

      const instructions = await advisor.getMigrationInstructions(
        "failed-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })
  })

  describe("GitHub Releases Parsing", () => {
    beforeEach(() => {
      const mockPackageInfo = JSON.stringify({
        repository: {
          url: "git+https://github.com/owner/repo.git",
        },
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))
    })

    it("should extract migration info from release notes with breaking changes", async () => {
      mockOctokit.repos.listReleases.mockResolvedValue({
        data: [
          {
            tag_name: "v2.0.0",
            body: "# Release v2.0.0\n\n## Breaking Changes\n- Removed deprecated API\n- Changed function signatures",
          },
        ],
      })

      const instructions = await advisor.getMigrationInstructions(
        "breaking-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("breaking-package Migration")
      expect(instructions).toContain("Breaking Changes")
      expect(instructions).toContain("Removed deprecated API")
    })

    it("should extract migration info from release notes with migration keywords", async () => {
      mockOctokit.repos.listReleases.mockResolvedValue({
        data: [
          {
            tag_name: "v2.0.0",
            body: "# Migration Guide\n\nTo migrate from v1 to v2:\n1. Update imports\n2. Change configuration",
          },
        ],
      })

      const instructions = await advisor.getMigrationInstructions(
        "migration-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("migration-package Migration")
      expect(instructions).toContain("Migration Guide")
    })

    it("should handle releases without migration information", async () => {
      mockOctokit.repos.listReleases.mockResolvedValue({
        data: [
          {
            tag_name: "v2.0.0",
            body: "# Release v2.0.0\n\nBug fixes and improvements",
          },
        ],
      })

      const instructions = await advisor.getMigrationInstructions(
        "simple-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })

    it("should handle GitHub API errors gracefully", async () => {
      mockOctokit.repos.listReleases.mockRejectedValue(
        new Error("API rate limit exceeded"),
      )

      const instructions = await advisor.getMigrationInstructions(
        "rate-limited-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })

    it("should handle non-GitHub repositories", async () => {
      const mockPackageInfo = JSON.stringify({
        repository: {
          url: "https://gitlab.com/owner/repo.git",
        },
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))

      const instructions = await advisor.getMigrationInstructions(
        "gitlab-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })
  })

  describe("Changelog Parsing", () => {
    beforeEach(() => {
      const mockPackageInfo = JSON.stringify({
        repository: {
          url: "git+https://github.com/owner/repo.git",
        },
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))
    })

    it("should fetch and parse CHANGELOG.md", async () => {
      mockOctokit.repos.listReleases.mockResolvedValue({ data: [] })

      const changelogContent = `# Changelog

## [2.0.0] - 2023-12-01

## Breaking Changes
- Removed legacy API
- Updated dependencies

### Migration Guide
1. Replace oldFunction() with newFunction()
2. Update configuration files
`

      mockOctokit.repos.getContent.mockResolvedValueOnce({
        data: {
          content: Buffer.from(changelogContent).toString("base64"),
        },
      })

      const instructions = await advisor.getMigrationInstructions(
        "changelog-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain(
        "changelog-package Major Version Update: 1.0.0 → 2.0.0",
      )
      expect(instructions).toContain("Major version change detected")
      expect(instructions).toContain("Review Release Notes")
    })

    it("should try multiple changelog file names", async () => {
      mockOctokit.repos.listReleases.mockResolvedValue({ data: [] })

      // First file doesn't exist
      mockOctokit.repos.getContent
        .mockRejectedValueOnce(new Error("Not found"))
        .mockResolvedValueOnce({
          data: {
            content: Buffer.from(
              "## Breaking Changes\nAPI updates require migration",
            ).toString("base64"),
          },
        })

      const instructions = await advisor.getMigrationInstructions(
        "alt-changelog-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain(
        "alt-changelog-package Major Version Update: 1.0.0 → 2.0.0",
      )
      expect(instructions).toContain("Major version change detected")
      expect(instructions).toContain("Review Release Notes")
    })

    it("should handle missing changelog files", async () => {
      mockOctokit.repos.listReleases.mockResolvedValue({ data: [] })
      mockOctokit.repos.getContent.mockRejectedValue(new Error("Not found"))

      const instructions = await advisor.getMigrationInstructions(
        "no-changelog-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })

    it("should handle malformed repository URLs", async () => {
      const mockPackageInfo = JSON.stringify({
        repository: {
          url: "invalid-url",
        },
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))

      const instructions = await advisor.getMigrationInstructions(
        "malformed-url-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })

    it("should extract upgrade-related sections from changelog", async () => {
      mockOctokit.repos.listReleases.mockResolvedValue({ data: [] })

      const changelogContent = `# Changelog

## Upgrade Instructions

When upgrading to v2.0.0:
- Update your configuration
- Run migration script

## Other Changes
- Bug fixes
`

      mockOctokit.repos.getContent.mockResolvedValueOnce({
        data: {
          content: Buffer.from(changelogContent).toString("base64"),
        },
      })

      const instructions = await advisor.getMigrationInstructions(
        "upgrade-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain(
        "upgrade-package Major Version Update: 1.0.0 → 2.0.0",
      )
      expect(instructions).toContain("Major version change detected")
      expect(instructions).toContain("Review Release Notes")
    })
  })

  describe("Version Matching", () => {
    class VersionTestProvider implements MigrationRuleProvider {
      getPackageName(): string {
        return "version-test"
      }

      getMigrationInfo(): PackageMigrationInfo {
        return {
          name: "version-test",
          rules: [
            {
              fromVersion: "1.x.x",
              toVersion: "2.x.x",
              priority: 1,
              instructions: "v1 to v2 migration",
              breakingChanges: [],
            },
            {
              fromVersion: "2.x.x",
              toVersion: "3.x.x",
              priority: 1,
              instructions: "v2 to v3 migration",
              breakingChanges: [],
            },
          ],
        }
      }
    }

    it("should match version ranges correctly", async () => {
      const provider = new VersionTestProvider()
      advisor.registerCustomProvider(provider)

      const instructions1to2 = await advisor.getMigrationInstructions(
        "version-test",
        "1.5.0",
        "2.1.0",
      )
      expect(instructions1to2).toContain("v1 to v2 migration")

      const instructions2to3 = await advisor.getMigrationInstructions(
        "version-test",
        "2.5.0",
        "3.0.0",
      )
      expect(instructions2to3).toContain("v2 to v3 migration")
    })

    it("should fallback to generic instructions for unmatched versions", async () => {
      const provider = new VersionTestProvider()
      advisor.registerCustomProvider(provider)

      const instructions = await advisor.getMigrationInstructions(
        "version-test",
        "3.0.0",
        "4.0.0",
      )
      expect(instructions).toContain("Major version change detected")
    })
  })

  describe("Integration Tests", () => {
    it("should prioritize known rules over external sources", async () => {
      class KnownRuleProvider implements MigrationRuleProvider {
        getPackageName(): string {
          return "known-package"
        }

        getMigrationInfo(): PackageMigrationInfo {
          return {
            name: "known-package",
            rules: [
              {
                fromVersion: "1.x.x",
                toVersion: "2.x.x",
                priority: 10,
                instructions: "Known migration instructions",
                breakingChanges: ["API changes"],
              },
            ],
          }
        }
      }

      advisor.registerCustomProvider(new KnownRuleProvider())

      // Mock external sources
      const mockPackageInfo = JSON.stringify({
        repository: {
          url: "git+https://github.com/owner/repo.git",
        },
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))
      mockOctokit.repos.listReleases.mockResolvedValue({
        data: [
          {
            tag_name: "v2.0.0",
            body: "External release notes",
          },
        ],
      })

      const instructions = await advisor.getMigrationInstructions(
        "known-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Known migration instructions")
      expect(instructions).not.toContain("External release notes")
    })

    it("should handle complex error scenarios gracefully", async () => {
      // Mock various failure scenarios
      mockExecSync.mockImplementation(() => {
        throw new Error("Command failed")
      })

      const instructions = await advisor.getMigrationInstructions(
        "complex-error-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
      expect(instructions).toContain("complex-error-package")
    })

    it("should handle authentication flow properly", async () => {
      const mockAuth = require("../../src/utils/auth")
      mockAuth.getGitHubToken = jest.fn().mockResolvedValue("mock-token")

      const mockPackageInfo = JSON.stringify({
        repository: {
          url: "git+https://github.com/owner/repo.git",
        },
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))

      // Test with unauthenticated Octokit that gets token later
      mockOctokit.rest = { repos: {} } // Simulate unauthenticated state with repos
      mockOctokit.repos.listReleases.mockResolvedValue({ data: [] })
      mockOctokit.repos.getContent.mockRejectedValue(new Error("Not found"))

      const instructions = await advisor.getMigrationInstructions(
        "auth-test-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toBeDefined()
    })
  })

  describe("Edge Cases and Robustness", () => {
    it("should handle empty changelog content", async () => {
      const mockPackageInfo = JSON.stringify({
        repository: {
          url: "git+https://github.com/owner/repo.git",
        },
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))

      mockOctokit.repos.listReleases.mockResolvedValue({ data: [] })
      mockOctokit.repos.getContent.mockResolvedValueOnce({
        data: {
          content: Buffer.from("").toString("base64"),
        },
      })

      const instructions = await advisor.getMigrationInstructions(
        "empty-changelog-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })

    it("should handle non-base64 content responses", async () => {
      const mockPackageInfo = JSON.stringify({
        repository: {
          url: "git+https://github.com/owner/repo.git",
        },
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))

      mockOctokit.repos.listReleases.mockResolvedValue({ data: [] })
      mockOctokit.repos.getContent.mockResolvedValueOnce({
        data: {
          // Missing content property
        },
      })

      const instructions = await advisor.getMigrationInstructions(
        "no-content-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })

    it("should handle invalid JSON from npm show", async () => {
      mockExecSync.mockReturnValue(Buffer.from("invalid json"))

      const instructions = await advisor.getMigrationInstructions(
        "invalid-json-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })

    it("should handle GitHub API rate limiting", async () => {
      const mockPackageInfo = JSON.stringify({
        repository: {
          url: "git+https://github.com/owner/repo.git",
        },
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))

      const rateLimitError = new Error("API rate limit exceeded")
      rateLimitError.name = "HttpError"
      mockOctokit.repos.listReleases.mockRejectedValue(rateLimitError)

      const instructions = await advisor.getMigrationInstructions(
        "rate-limited-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })

    it("should handle malformed GitHub URLs in repository", async () => {
      const mockPackageInfo = JSON.stringify({
        repository: {
          url: "github.com/missing-protocol",
        },
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))

      const instructions = await advisor.getMigrationInstructions(
        "malformed-github-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })

    it("should handle releases with no matching version", async () => {
      const mockPackageInfo = JSON.stringify({
        repository: {
          url: "git+https://github.com/owner/repo.git",
        },
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))

      mockOctokit.repos.listReleases.mockResolvedValue({
        data: [
          {
            tag_name: "v1.0.0",
            body: "Old release",
          },
          {
            tag_name: "v3.0.0",
            body: "Future release",
          },
        ],
      })

      const instructions = await advisor.getMigrationInstructions(
        "no-matching-release-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })

    it("should handle releases with null body", async () => {
      const mockPackageInfo = JSON.stringify({
        repository: {
          url: "git+https://github.com/owner/repo.git",
        },
      })
      mockExecSync.mockReturnValue(Buffer.from(mockPackageInfo))

      mockOctokit.repos.listReleases.mockResolvedValue({
        data: [
          {
            tag_name: "v2.0.0",
            body: null,
          },
        ],
      })

      const instructions = await advisor.getMigrationInstructions(
        "null-body-package",
        "1.0.0",
        "2.0.0",
      )

      expect(instructions).toContain("Major version change detected")
    })

    it("should handle same version migration requests", async () => {
      const instructions = await advisor.getMigrationInstructions(
        "same-version-package",
        "1.0.0",
        "1.0.0",
      )

      expect(instructions).toContain("minor/patch update")
    })

    it("should handle version downgrades", async () => {
      const instructions = await advisor.getMigrationInstructions(
        "downgrade-package",
        "2.0.0",
        "1.0.0",
      )

      expect(instructions).toContain("minor/patch update")
    })
  })
})
