import { MigrationRuleProvider, PackageMigrationInfo } from "../types";

export class JestMigrationProvider implements MigrationRuleProvider {
  getPackageName(): string {
    return "jest";
  }

  getMigrationInfo(): PackageMigrationInfo {
    return {
      name: "jest",
      tags: ["testing", "framework"],
      rules: [
        {
          fromVersion: "28.x.x",
          toVersion: "29.x.x",
          priority: 1,
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
          automatedFixes: [
            "Update import statements",
            "Update jest configuration",
          ],
        },
        {
          fromVersion: "29.x.x",
          toVersion: "30.x.x",
          priority: 1,
          instructions: `## Jest 30 Migration Guide

### Key Changes:
1. **ESM Support**: Better ES modules support
2. **Node.js Support**: Requires Node.js 16+
3. **API Changes**: Some APIs deprecated or changed

### Migration Steps:
1. Update Node.js version to 16+
2. Review ESM configuration in jest.config.js
3. Update any deprecated API usage

### Resources:
- [Jest 30 Release Notes](https://jestjs.io/blog)`,
          breakingChanges: [
            "Node.js version requirement",
            "ESM handling changes",
            "Deprecated APIs removed",
          ],
        },
      ],
      repositoryUrl: "https://github.com/facebook/jest",
      changelogUrl: "https://github.com/facebook/jest/releases",
      documentationUrl: "https://jestjs.io/docs/getting-started",
    };
  }
}
