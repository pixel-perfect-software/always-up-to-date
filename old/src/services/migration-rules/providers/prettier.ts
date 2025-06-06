import { MigrationRuleProvider, PackageMigrationInfo } from "../types"

export class PrettierMigrationProvider implements MigrationRuleProvider {
  getPackageName(): string {
    return "prettier"
  }

  getMigrationInfo(): PackageMigrationInfo {
    return {
      name: "prettier",
      tags: ["formatting", "code-quality", "build-tool", "linting"],
      rules: [
        {
          fromVersion: "2.x.x",
          toVersion: "3.x.x",
          priority: 1,
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
          automatedFixes: [
            "Update .prettierrc configuration",
            "Update plugin configurations",
          ],
        },
      ],
      repositoryUrl: "https://github.com/prettier/prettier",
      changelogUrl: "https://github.com/prettier/prettier/releases",
      documentationUrl: "https://prettier.io/docs/en/",
    }
  }
}
