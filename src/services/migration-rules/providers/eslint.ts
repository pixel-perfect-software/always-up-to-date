import { MigrationRuleProvider, PackageMigrationInfo } from "../types";

export class EslintMigrationProvider implements MigrationRuleProvider {
  getPackageName(): string {
    return "eslint";
  }

  getMigrationInfo(): PackageMigrationInfo {
    return {
      name: "eslint",
      tags: ["linting", "code-quality", "build-tool"],
      rules: [
        {
          fromVersion: "8.x.x",
          toVersion: "9.x.x",
          priority: 1,
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
          automatedFixes: [
            "Convert .eslintrc to eslint.config.js",
            "Update package.json scripts",
            "Remove deprecated rule configurations",
          ],
        },
      ],
      repositoryUrl: "https://github.com/eslint/eslint",
      changelogUrl: "https://github.com/eslint/eslint/releases",
      documentationUrl: "https://eslint.org/docs/latest/",
    };
  }
}
