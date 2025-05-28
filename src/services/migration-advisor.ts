import { Octokit } from "@octokit/rest";
import { logger } from "../utils/logger";
import { NetworkError, DependencyError, withRetry } from "../utils/errors";
import { execSync } from "child_process";

interface MigrationRule {
  fromVersion: string;
  toVersion: string;
  instructions: string;
  breakingChanges: string[];
  automatedFixes?: string[];
}

interface PackageMigrationInfo {
  name: string;
  rules: MigrationRule[];
  repositoryUrl?: string;
  changelogUrl?: string;
}

export class MigrationAdvisor {
  private octokit: Octokit;
  private migrationRules: Map<string, PackageMigrationInfo> = new Map();

  constructor(githubToken?: string) {
    this.octokit = new Octokit({
      auth: githubToken || process.env.GITHUB_TOKEN,
    });
    this.initializeKnownMigrations();
  }

  /**
   * Gets comprehensive migration instructions for a package update
   */
  async getMigrationInstructions(
    packageName: string,
    fromVersion: string,
    toVersion: string
  ): Promise<string> {
    try {
      // Check for known migration rules first
      const knownMigration = await this.getKnownMigrationInstructions(
        packageName,
        fromVersion,
        toVersion
      );

      if (knownMigration) {
        return knownMigration;
      }

      // Try to fetch from changelog
      const changelogInstructions = await this.parseChangelogForMigration(
        packageName,
        fromVersion,
        toVersion
      );

      if (changelogInstructions) {
        return changelogInstructions;
      }

      // Try to fetch from GitHub releases
      const releaseInstructions = await this.parseGitHubReleases(
        packageName,
        fromVersion,
        toVersion
      );

      if (releaseInstructions) {
        return releaseInstructions;
      }

      // Fallback to generic instructions
      return this.generateGenericMigrationInstructions(
        packageName,
        fromVersion,
        toVersion
      );
    } catch (error) {
      logger.error(
        new DependencyError(
          `Error generating migration instructions for ${packageName}`,
          packageName,
          error as Error
        )
      );
      return this.generateGenericMigrationInstructions(
        packageName,
        fromVersion,
        toVersion
      );
    }
  }

  /**
   * Initialize known migration rules for popular packages
   */
  private initializeKnownMigrations(): void {
    // React
    this.migrationRules.set("react", {
      name: "react",
      rules: [
        {
          fromVersion: "17.x.x",
          toVersion: "18.x.x",
          instructions: `## React 18 Migration Guide

### Key Changes:
1. **Automatic Batching**: Updates are now batched by default
2. **Strict Mode**: New behaviors for useEffect in development
3. **New Root API**: ReactDOM.render is deprecated

### Migration Steps:
1. Update your root element:
   \`\`\`jsx
   // Before
   ReactDOM.render(<App />, document.getElementById('root'));

   // After
   const root = ReactDOM.createRoot(document.getElementById('root'));
   root.render(<App />);
   \`\`\`

2. Update your tests to use the new testing utilities
3. Review useEffect dependencies for double-execution in Strict Mode

### Resources:
- [React 18 Upgrade Guide](https://react.dev/blog/2022/03/08/react-18-upgrade-guide)`,
          breakingChanges: [
            "ReactDOM.render deprecated",
            "Automatic batching changes",
            "Strict Mode behavior changes",
          ],
        },
      ],
      repositoryUrl: "https://github.com/facebook/react",
      changelogUrl: "https://github.com/facebook/react/blob/main/CHANGELOG.md",
    });

    // Next.js
    this.migrationRules.set("next", {
      name: "next",
      rules: [
        {
          fromVersion: "13.x.x",
          toVersion: "14.x.x",
          instructions: `## Next.js 14 Migration Guide

### Key Changes:
1. **App Router Stable**: App Router is now stable
2. **Server Actions**: Server Actions are now stable
3. **Image Component**: Improved Image component with better performance

### Migration Steps:
1. Update your \`next.config.js\` if using experimental features:
   \`\`\`js
   // Remove experimental flags that are now stable
   const nextConfig = {
     experimental: {
       // Remove: appDir, serverActions, etc.
     }
   }
   \`\`\`

2. Update imports for moved APIs
3. Review and update any deprecated APIs

### Resources:
- [Next.js 14 Upgrade Guide](https://nextjs.org/docs/upgrading)`,
          breakingChanges: [
            "Some experimental APIs moved to stable",
            "Deprecated APIs removed",
            "Image component changes",
          ],
        },
      ],
      repositoryUrl: "https://github.com/vercel/next.js",
      changelogUrl: "https://github.com/vercel/next.js/releases",
    });

    // TypeScript
    this.migrationRules.set("typescript", {
      name: "typescript",
      rules: [
        {
          fromVersion: "4.x.x",
          toVersion: "5.x.x",
          instructions: `## TypeScript 5 Migration Guide

### Key Changes:
1. **New Decorators**: ES Decorators implementation
2. **Module Resolution**: Improved module resolution
3. **Performance**: Better performance for large projects

### Migration Steps:
1. Update your \`tsconfig.json\`:
   \`\`\`json
   {
     "compilerOptions": {
       "target": "ES2022",
       "experimentalDecorators": false, // Remove if using new decorators
       "useDefineForClassFields": true
     }
   }
   \`\`\`

2. Update decorator syntax if used:
   \`\`\`ts
   // Before (experimental)
   @decorator
   class MyClass {}

   // After (standard)
   @decorator
   class MyClass {}
   \`\`\`

3. Review and fix any new strict type checking errors

### Resources:
- [TypeScript 5.0 Release Notes](https://devblogs.microsoft.com/typescript/announcing-typescript-5-0/)`,
          breakingChanges: [
            "Decorator changes",
            "Stricter type checking",
            "Module resolution changes",
          ],
        },
      ],
      repositoryUrl: "https://github.com/microsoft/TypeScript",
      changelogUrl: "https://github.com/Microsoft/TypeScript/releases",
    });

    // Add more popular packages...
    this.addEslintMigration();
    this.addPrettierMigration();
    this.addJestMigration();
  }

  private addEslintMigration(): void {
    this.migrationRules.set("eslint", {
      name: "eslint",
      rules: [
        {
          fromVersion: "8.x.x",
          toVersion: "9.x.x",
          instructions: `## ESLint 9 Migration Guide

### Key Changes:
1. **Flat Config**: New flat config format is now default
2. **Removed Rules**: Some deprecated rules removed
3. **Node.js Support**: Requires Node.js 18.18.0+

### Migration Steps:
1. Migrate to flat config (\`eslint.config.js\`):
   \`\`\`js
   // eslint.config.js
   export default [
     {
       files: ["**/*.js"],
       rules: {
         // Your rules here
       }
     }
   ];
   \`\`\`

2. Update your package.json scripts
3. Review and update any custom plugins

### Resources:
- [ESLint 9 Migration Guide](https://eslint.org/docs/latest/use/migrate-to-9.0.0)`,
          breakingChanges: [
            "Flat config format required",
            "Deprecated rules removed",
            "Node.js version requirement",
          ],
        },
      ],
      repositoryUrl: "https://github.com/eslint/eslint",
    });
  }

  private addPrettierMigration(): void {
    this.migrationRules.set("prettier", {
      name: "prettier",
      rules: [
        {
          fromVersion: "2.x.x",
          toVersion: "3.x.x",
          instructions: `## Prettier 3 Migration Guide

### Key Changes:
1. **Node.js Support**: Requires Node.js 14+
2. **Configuration**: Some config options changed
3. **Plugins**: Plugin API updated

### Migration Steps:
1. Update Node.js version to 14+
2. Review configuration options in \`.prettierrc\`
3. Update any custom plugins

### Resources:
- [Prettier 3.0 Release Notes](https://prettier.io/blog/2023/07/05/3.0.0.html)`,
          breakingChanges: [
            "Node.js version requirement",
            "Configuration changes",
            "Plugin API changes",
          ],
        },
      ],
      repositoryUrl: "https://github.com/prettier/prettier",
    });
  }

  private addJestMigration(): void {
    this.migrationRules.set("jest", {
      name: "jest",
      rules: [
        {
          fromVersion: "28.x.x",
          toVersion: "29.x.x",
          instructions: `## Jest 29 Migration Guide

### Key Changes:
1. **Node.js Support**: Requires Node.js 14.15.0+
2. **Default Export**: Package now uses default export
3. **Snapshot Testing**: Improved snapshot testing

### Migration Steps:
1. Update Node.js version
2. Update import statements:
   \`\`\`js
   // Before
   const jest = require('jest');

   // After
   import jest from 'jest';
   \`\`\`

3. Review jest configuration

### Resources:
- [Jest 29 Release Notes](https://jestjs.io/blog/2022/08/25/jest-29)`,
          breakingChanges: [
            "Node.js version requirement",
            "Module system changes",
            "API changes",
          ],
        },
      ],
      repositoryUrl: "https://github.com/facebook/jest",
    });
  }

  /**
   * Check known migration rules for specific package and version range
   */
  private async getKnownMigrationInstructions(
    packageName: string,
    fromVersion: string,
    toVersion: string
  ): Promise<string | null> {
    const packageInfo = this.migrationRules.get(packageName);
    if (!packageInfo) {
      return null;
    }

    // Find applicable migration rule
    for (const rule of packageInfo.rules) {
      if (
        this.versionMatchesRange(fromVersion, rule.fromVersion) &&
        this.versionMatchesRange(toVersion, rule.toVersion)
      ) {
        return rule.instructions;
      }
    }

    return null;
  }

  /**
   * Parse changelog for migration information
   */
  private async parseChangelogForMigration(
    packageName: string,
    fromVersion: string,
    toVersion: string
  ): Promise<string | null> {
    try {
      // Try to get package info from npm to find repository
      const packageInfo = await this.getPackageRepository(packageName);
      if (!packageInfo.repositoryUrl) {
        return null;
      }

      const changelogContent = await this.fetchChangelog(
        packageInfo.repositoryUrl
      );
      if (!changelogContent) {
        return null;
      }

      return this.extractMigrationFromChangelog(
        changelogContent,
        fromVersion,
        toVersion,
        packageName
      );
    } catch (error) {
      logger.debug(
        `Failed to parse changelog for ${packageName}: ${
          (error as Error).message
        }`
      );
      return null;
    }
  }

  /**
   * Parse GitHub releases for migration information
   */
  private async parseGitHubReleases(
    packageName: string,
    fromVersion: string,
    toVersion: string
  ): Promise<string | null> {
    try {
      const packageInfo = await this.getPackageRepository(packageName);
      if (!packageInfo.githubRepo) {
        return null;
      }

      const [owner, repo] = packageInfo.githubRepo.split("/");
      const releases = await withRetry(async () => {
        const { data } = await this.octokit.repos.listReleases({
          owner,
          repo,
          per_page: 10,
        });
        return data;
      });

      const targetRelease = releases.find((release) =>
        release.tag_name.includes(toVersion.split(".")[0])
      );

      if (targetRelease && targetRelease.body) {
        return this.extractMigrationFromReleaseNotes(
          targetRelease.body,
          fromVersion,
          toVersion,
          packageName
        );
      }

      return null;
    } catch (error) {
      logger.debug(
        `Failed to parse GitHub releases for ${packageName}: ${
          (error as Error).message
        }`
      );
      return null;
    }
  }

  /**
   * Extract migration information from changelog content
   */
  private extractMigrationFromChangelog(
    content: string,
    fromVersion: string,
    toVersion: string,
    packageName: string
  ): string | null {
    // Look for breaking changes sections
    const breakingChangePatterns = [
      /## .*breaking.*changes/gi,
      /### .*breaking.*changes/gi,
      /## .*migration/gi,
      /### .*migration/gi,
      /## .*upgrade/gi,
      /### .*upgrade/gi,
    ];

    for (const pattern of breakingChangePatterns) {
      const matches = content.match(pattern);
      if (matches) {
        // Extract content around these sections
        const sections = content.split(/^##/gm);
        for (const section of sections) {
          if (pattern.test(section)) {
            return this.formatMigrationInstructions(
              section,
              packageName,
              fromVersion,
              toVersion
            );
          }
        }
      }
    }

    return null;
  }

  /**
   * Extract migration information from release notes
   */
  private extractMigrationFromReleaseNotes(
    content: string,
    fromVersion: string,
    toVersion: string,
    packageName: string
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
        toVersion
      );
    }

    return null;
  }

  /**
   * Format migration instructions consistently
   */
  private formatMigrationInstructions(
    content: string,
    packageName: string,
    fromVersion: string,
    toVersion: string
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
- Search for "${packageName} ${toVersion} migration guide" for community resources`;
  }

  /**
   * Generate generic migration instructions
   */
  private generateGenericMigrationInstructions(
    packageName: string,
    fromVersion: string,
    toVersion: string
  ): string {
    const majorVersionChange =
      parseInt(toVersion.split(".")[0]) > parseInt(fromVersion.split(".")[0]);

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

**Tip**: Consider updating in a separate branch and testing thoroughly before merging.`;
    }

    return `## ${packageName} Update: ${fromVersion} → ${toVersion}

### This appears to be a minor/patch update with minimal breaking changes.

### Recommended Steps:
1. Update the package
2. Run your test suite to ensure compatibility
3. Check for any deprecation warnings in your application

### Resources:
- Package page: https://www.npmjs.com/package/${packageName}
- Release notes: Check the package's repository for detailed changes`;
  }

  /**
   * Get package repository information
   */
  private async getPackageRepository(packageName: string): Promise<{
    repositoryUrl?: string;
    githubRepo?: string;
  }> {
    try {
      const command = `npm show ${packageName} repository --json`;
      const result = execSync(command, { stdio: "pipe" }).toString();
      const packageInfo = JSON.parse(result);

      if (packageInfo.repository) {
        const repoUrl =
          typeof packageInfo.repository === "string"
            ? packageInfo.repository
            : packageInfo.repository.url;

        // Extract GitHub repo from URL
        const githubMatch = repoUrl.match(/github\.com[\/:]([^\/]+\/[^\/\.]+)/);
        const githubRepo = githubMatch ? githubMatch[1] : undefined;

        return {
          repositoryUrl: repoUrl,
          githubRepo,
        };
      }

      return {};
    } catch (error) {
      logger.debug(`Failed to get repository info for ${packageName}`);
      return {};
    }
  }

  /**
   * Fetch changelog from repository
   */
  private async fetchChangelog(repositoryUrl: string): Promise<string | null> {
    try {
      if (!repositoryUrl.includes("github.com")) {
        return null;
      }

      const githubMatch = repositoryUrl.match(
        /github\.com[\/:]([^\/]+\/[^\/\.]+)/
      );
      if (!githubMatch) {
        return null;
      }

      const [owner, repo] = githubMatch[1].split("/");

      // Try common changelog file names
      const changelogFiles = [
        "CHANGELOG.md",
        "CHANGELOG.rst",
        "CHANGELOG.txt",
        "CHANGES.md",
      ];

      for (const filename of changelogFiles) {
        try {
          const { data } = await this.octokit.repos.getContent({
            owner,
            repo,
            path: filename,
          });

          if ("content" in data && data.content) {
            return Buffer.from(data.content, "base64").toString("utf8");
          }
        } catch (error) {
          // File doesn't exist, try next one
          continue;
        }
      }

      return null;
    } catch (error) {
      logger.debug(`Failed to fetch changelog: ${(error as Error).message}`);
      return null;
    }
  }

  /**
   * Check if version matches a version range pattern
   */
  private versionMatchesRange(version: string, range: string): boolean {
    const versionMajor = parseInt(version.split(".")[0]);
    const rangeMajor = parseInt(range.split(".")[0]);

    // Simple major version matching for now
    // Could be enhanced with proper semver range matching
    return versionMajor === rangeMajor;
  }
}
