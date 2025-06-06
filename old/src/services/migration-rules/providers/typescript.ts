import { MigrationRuleProvider, PackageMigrationInfo } from "../types"

export class TypeScriptMigrationProvider implements MigrationRuleProvider {
  getPackageName(): string {
    return "typescript"
  }

  getMigrationInfo(): PackageMigrationInfo {
    return {
      name: "typescript",
      tags: ["language", "types", "build-tool"],
      rules: [
        {
          fromVersion: "4.x.x",
          toVersion: "5.x.x",
          priority: 1,
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
          automatedFixes: [
            "Update tsconfig.json for new decorator syntax",
            "Update decorator usage in classes",
          ],
        },
        {
          fromVersion: "5.4.x",
          toVersion: "5.5.x",
          priority: 2,
          instructions: `## TypeScript 5.5 Migration Guide

### Key Changes:
1. **Inferred Type Predicates**: Better type narrowing
2. **Control Flow Analysis**: Improved analysis for destructured discriminated unions
3. **Performance**: Better performance for large codebases

### Migration Steps:
1. Review any type assertions that may now be unnecessary
2. Check for new type errors from improved analysis
3. Update any custom type guards if needed

### Resources:
- [TypeScript 5.5 Release Notes](https://devblogs.microsoft.com/typescript/announcing-typescript-5-5/)`,
          breakingChanges: [
            "Stricter type checking in some cases",
            "Changes to type inference",
          ],
        },
      ],
      repositoryUrl: "https://github.com/microsoft/TypeScript",
      changelogUrl: "https://github.com/Microsoft/TypeScript/releases",
      documentationUrl: "https://www.typescriptlang.org/docs/",
    }
  }
}
