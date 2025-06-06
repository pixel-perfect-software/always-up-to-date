import { Octokit } from "@octokit/rest"
import { logger } from "../utils/logger"
import { DependencyError, withRetry } from "../utils/errors"
import { execSync } from "child_process"
import { getGitHubToken } from "../utils/auth"
import {
  MigrationRuleRegistry,
  MigrationPluginLoader,
  MigrationRuleProvider,
} from "./migration-rules"

export class MigrationAdvisor {
  private octokit: Octokit
  private ruleRegistry: MigrationRuleRegistry
  private pluginLoader: MigrationPluginLoader

  constructor(githubToken?: string, customRulesPath?: string) {
    // Initialize with provided token or use auth service
    if (githubToken) {
      this.octokit = new Octokit({ auth: githubToken })
    } else {
      this.octokit = new Octokit()
    }

    this.ruleRegistry = new MigrationRuleRegistry()
    this.pluginLoader = new MigrationPluginLoader(this.ruleRegistry)

    // Load custom rules if path provided
    if (customRulesPath) {
      this.loadCustomRules(customRulesPath)
    }
  }

  private async loadCustomRules(rulesPath: string): Promise<void> {
    try {
      await this.pluginLoader.loadFromDirectory(rulesPath)

      // Also try to load from config file
      const configPath = `${rulesPath}/migration-rules.json`
      await this.pluginLoader.loadFromConfig(configPath)
    } catch (error) {
      logger.warn(`Failed to load custom migration rules: ${error}`)
    }
  }

  /**
   * Register a custom migration rule provider
   */
  registerCustomProvider(provider: MigrationRuleProvider): void {
    this.ruleRegistry.registerProvider(provider)
  }

  /**
   * Get list of supported packages
   */
  getSupportedPackages(): string[] {
    return this.ruleRegistry.listSupportedPackages()
  }

  /**
   * Search for providers by tag (e.g., 'framework', 'testing')
   */
  searchProvidersByTag(tag: string): string[] {
    return this.ruleRegistry
      .searchProvidersByTag(tag)
      .map((provider) => provider.getPackageName())
  }

  /**
   * Initialize Octokit with token from auth service if not already done
   */
  private async ensureAuthenticated(): Promise<void> {
    if (!this.octokit.rest.repos) {
      const token = await getGitHubToken()
      if (token) {
        this.octokit = new Octokit({ auth: token })
      }
    }
  }

  /**
   * Gets comprehensive migration instructions for a package update
   */
  async getMigrationInstructions(
    packageName: string,
    fromVersion: string,
    toVersion: string,
  ): Promise<string> {
    try {
      // Check for known migration rules first
      const knownMigration = await this.getKnownMigrationInstructions(
        packageName,
        fromVersion,
        toVersion,
      )

      if (knownMigration) {
        return knownMigration
      }

      // Try to fetch from changelog
      const changelogInstructions = await this.parseChangelogForMigration(
        packageName,
        fromVersion,
        toVersion,
      )

      if (changelogInstructions) {
        return changelogInstructions
      }

      // Try to fetch from GitHub releases
      const releaseInstructions = await this.parseGitHubReleases(
        packageName,
        fromVersion,
        toVersion,
      )

      if (releaseInstructions) {
        return releaseInstructions
      }

      // Fallback to generic instructions
      return this.generateGenericMigrationInstructions(
        packageName,
        fromVersion,
        toVersion,
      )
    } catch (error) {
      logger.error(
        new DependencyError(
          `Error generating migration instructions for ${packageName}`,
          packageName,
          error as Error,
        ),
      )
      return this.generateGenericMigrationInstructions(
        packageName,
        fromVersion,
        toVersion,
      )
    }
  }

  /**
   * Check known migration rules for specific package and version range
   */
  private async getKnownMigrationInstructions(
    packageName: string,
    fromVersion: string,
    toVersion: string,
  ): Promise<string | null> {
    const packageInfo = this.ruleRegistry.getPackageMigrationInfo(packageName)
    if (!packageInfo) {
      return null
    }

    // Sort rules by priority (higher first)
    const sortedRules = packageInfo.rules.sort(
      (a, b) => (b.priority || 0) - (a.priority || 0),
    )

    // Find applicable migration rule
    for (const rule of sortedRules) {
      if (
        this.versionMatchesRange(fromVersion, rule.fromVersion) &&
        this.versionMatchesRange(toVersion, rule.toVersion)
      ) {
        return rule.instructions
      }
    }

    return null
  }

  /**
   * Parse changelog for migration information
   */
  private async parseChangelogForMigration(
    packageName: string,
    fromVersion: string,
    toVersion: string,
  ): Promise<string | null> {
    try {
      // Try to get package info from npm to find repository
      const packageInfo = await this.getPackageRepository(packageName)
      if (!packageInfo.repositoryUrl) {
        return null
      }

      const changelogContent = await this.fetchChangelog(
        packageInfo.repositoryUrl,
      )
      if (!changelogContent) {
        return null
      }

      return this.extractMigrationFromChangelog(
        changelogContent,
        fromVersion,
        toVersion,
        packageName,
      )
    } catch (error) {
      logger.debug(
        `Failed to parse changelog for ${packageName}: ${
          (error as Error).message
        }`,
      )
      return null
    }
  }

  /**
   * Parse GitHub releases for migration information
   */
  private async parseGitHubReleases(
    packageName: string,
    fromVersion: string,
    toVersion: string,
  ): Promise<string | null> {
    try {
      await this.ensureAuthenticated()

      const packageInfo = await this.getPackageRepository(packageName)
      if (!packageInfo.githubRepo) {
        return null
      }

      const [owner, repo] = packageInfo.githubRepo.split("/")
      const releases = await withRetry(async () => {
        const { data } = await this.octokit.repos.listReleases({
          owner,
          repo,
          per_page: 10,
        })
        return data
      })

      const targetRelease = releases.find((release) =>
        release.tag_name.includes(toVersion.split(".")[0]),
      )

      if (targetRelease && targetRelease.body) {
        return this.extractMigrationFromReleaseNotes(
          targetRelease.body,
          fromVersion,
          toVersion,
          packageName,
        )
      }

      return null
    } catch (error) {
      logger.debug(
        `Failed to parse GitHub releases for ${packageName}: ${
          (error as Error).message
        }`,
      )
      return null
    }
  }

  /**
   * Extract migration information from changelog content
   */
  private extractMigrationFromChangelog(
    content: string,
    fromVersion: string,
    toVersion: string,
    packageName: string,
  ): string | null {
    // Look for breaking changes sections
    const breakingChangePatterns = [
      /## .*breaking.*changes/gi,
      /### .*breaking.*changes/gi,
      /## .*migration/gi,
      /### .*migration/gi,
      /## .*upgrade/gi,
      /### .*upgrade/gi,
    ]

    for (const pattern of breakingChangePatterns) {
      const matches = content.match(pattern)
      if (matches) {
        // Extract content around these sections
        const sections = content.split(/^##/gm)
        for (const section of sections) {
          if (pattern.test(section)) {
            return this.formatMigrationInstructions(
              section,
              packageName,
              fromVersion,
              toVersion,
            )
          }
        }
      }
    }

    return null
  }

  /**
   * Extract migration information from release notes
   */
  private extractMigrationFromReleaseNotes(
    content: string,
    fromVersion: string,
    toVersion: string,
    packageName: string,
  ): string | null {
    // Similar to changelog extraction but for release notes format
    if (
      content.toLowerCase().includes("breaking") ||
      content.toLowerCase().includes("migration")
    ) {
      return this.formatMigrationInstructions(
        content,
        packageName,
        fromVersion,
        toVersion,
      )
    }

    return null
  }

  /**
   * Format migration instructions consistently
   */
  private formatMigrationInstructions(
    content: string,
    packageName: string,
    fromVersion: string,
    toVersion: string,
  ): string {
    return `## ${packageName} Migration: ${fromVersion} → ${toVersion}

${content}

### Additional Steps:
1. Review your codebase for any usage of deprecated APIs
2. Update your tests to account for any behavior changes
3. Check the official documentation for complete migration guide
4. Consider updating related packages that may be affected

### Resources:
- Package documentation: https://www.npmjs.com/package/${packageName}
- Search for "${packageName} ${toVersion} migration guide" for community resources`
  }

  /**
   * Generate generic migration instructions
   */
  private generateGenericMigrationInstructions(
    packageName: string,
    fromVersion: string,
    toVersion: string,
  ): string {
    const majorVersionChange =
      parseInt(toVersion.split(".")[0]) > parseInt(fromVersion.split(".")[0])

    if (majorVersionChange) {
      return `## ${packageName} Major Version Update: ${fromVersion} → ${toVersion}

⚠️ **Major version change detected** - This update may include breaking changes.

### Recommended Steps:
1. **Review Release Notes**: Check the package's GitHub releases or changelog
2. **Update Dependencies**: Ensure compatible versions of related packages
3. **Test Thoroughly**: Run your test suite and manual testing
4. **Check Documentation**: Review updated API documentation
5. **Update Code**: Look for deprecated API usage and update accordingly

### Common Breaking Changes in Major Updates:
- API signature changes
- Removed deprecated methods
- Changed default behaviors
- Minimum Node.js version requirements
- Dependency requirement changes

### Resources:
- Package page: https://www.npmjs.com/package/${packageName}
- GitHub repository: Search for "${packageName} repository"
- Migration guides: Search for "${packageName} ${toVersion} migration guide"

**Tip**: Consider updating in a separate branch and testing thoroughly before merging.`
    }

    return `## ${packageName} Update: ${fromVersion} → ${toVersion}

### This appears to be a minor/patch update with minimal breaking changes.

### Recommended Steps:
1. Update the package
2. Run your test suite to ensure compatibility
3. Check for any deprecation warnings in your application

### Resources:
- Package page: https://www.npmjs.com/package/${packageName}
- Release notes: Check the package's repository for detailed changes`
  }

  /**
   * Get package repository information
   */
  private async getPackageRepository(packageName: string): Promise<{
    repositoryUrl?: string
    githubRepo?: string
  }> {
    try {
      const command = `npm show ${packageName} repository --json`
      const result = execSync(command, { stdio: "pipe" }).toString()
      const packageInfo = JSON.parse(result)

      if (packageInfo.repository) {
        const repoUrl =
          typeof packageInfo.repository === "string"
            ? packageInfo.repository
            : packageInfo.repository.url

        // Extract GitHub repo from URL
        const githubMatch = repoUrl.match(/github\.com[\/:]([^\/]+\/[^\/\.]+)/)
        const githubRepo = githubMatch ? githubMatch[1] : undefined

        return {
          repositoryUrl: repoUrl,
          githubRepo,
        }
      }

      return {}
    } catch (error) {
      logger.debug(`Failed to get repository info for ${packageName}`)
      return {}
    }
  }

  /**
   * Fetch changelog from repository
   */
  private async fetchChangelog(repositoryUrl: string): Promise<string | null> {
    try {
      if (!repositoryUrl.includes("github.com")) {
        return null
      }

      await this.ensureAuthenticated()

      const githubMatch = repositoryUrl.match(
        /github\.com[\/:]([^\/]+\/[^\/\.]+)/,
      )
      if (!githubMatch) {
        return null
      }

      const [owner, repo] = githubMatch[1].split("/")

      // Try common changelog file names
      const changelogFiles = [
        "CHANGELOG.md",
        "CHANGELOG.rst",
        "CHANGELOG.txt",
        "CHANGES.md",
      ]

      for (const filename of changelogFiles) {
        try {
          const { data } = await this.octokit.repos.getContent({
            owner,
            repo,
            path: filename,
          })

          if ("content" in data && data.content) {
            return Buffer.from(data.content, "base64").toString("utf8")
          }
        } catch (error) {
          // File doesn't exist, try next one
          continue
        }
      }

      return null
    } catch (error) {
      logger.debug(`Failed to fetch changelog: ${(error as Error).message}`)
      return null
    }
  }

  /**
   * Check if version matches a version range pattern
   */
  private versionMatchesRange(version: string, range: string): boolean {
    const versionMajor = parseInt(version.split(".")[0])
    const rangeMajor = parseInt(range.split(".")[0])

    // Simple major version matching for now
    // Could be enhanced with proper semver range matching
    return versionMajor === rangeMajor
  }
}
