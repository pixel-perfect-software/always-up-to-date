# Migration Rules Examples

This directory contains examples of how to extend the Migration Advisor with custom rules for your packages.

## Overview

The Migration Advisor now supports a modular architecture that allows you to:

1. **Add Custom Providers**: Create TypeScript classes for complex migration logic
2. **Use JSON Configuration**: Define simple migration rules in JSON format
3. **Load External Rules**: Load rules from external directories or npm packages

## Usage Examples

### 1. Using Custom Providers (TypeScript)

Create a TypeScript file with custom migration providers:

```typescript
// custom-providers.ts
import { MigrationRuleProvider, PackageMigrationInfo } from "always-up-to-date";

export class MyPackageMigrationProvider implements MigrationRuleProvider {
  getPackageName(): string {
    return "my-package";
  }

  getMigrationInfo(): PackageMigrationInfo {
    return {
      name: "my-package",
      tags: ["custom"],
      rules: [
        {
          fromVersion: "1.x.x",
          toVersion: "2.x.x",
          instructions: "## Migration instructions here...",
          breakingChanges: ["API changed"],
          priority: 1,
        },
      ],
    };
  }
}
```

Load it in your application:

```typescript
import { MigrationAdvisor } from "always-up-to-date";
import { MyPackageMigrationProvider } from "./custom-providers";

const advisor = new MigrationAdvisor();
advisor.registerCustomProvider(new MyPackageMigrationProvider());
```

### 2. Using JSON Configuration

Create a `migration-rules.json` file:

```json
{
  "migrationRules": {
    "my-package": {
      "name": "my-package",
      "tags": ["custom"],
      "rules": [
        {
          "fromVersion": "1.x.x",
          "toVersion": "2.x.x",
          "instructions": "## Migration instructions...",
          "breakingChanges": ["API changed"]
        }
      ]
    }
  }
}
```

Load it:

```typescript
const advisor = new MigrationAdvisor(undefined, "./path/to/rules");
```

### 3. Loading from Directory

Create a directory structure:

```
custom-rules/
├── migration-rules.json
├── package-a.ts
└── package-b.ts
```

Pass the directory path to the constructor:

```typescript
const advisor = new MigrationAdvisor(undefined, "./custom-rules");
```

## API Reference

### MigrationRuleProvider Interface

```typescript
interface MigrationRuleProvider {
  getPackageName(): string;
  getMigrationInfo(): PackageMigrationInfo;
}
```

### PackageMigrationInfo Interface

```typescript
interface PackageMigrationInfo {
  name: string;
  rules: MigrationRule[];
  repositoryUrl?: string;
  changelogUrl?: string;
  documentationUrl?: string;
  tags?: string[];
}
```

### MigrationRule Interface

```typescript
interface MigrationRule {
  fromVersion: string;
  toVersion: string;
  instructions: string;
  breakingChanges: string[];
  automatedFixes?: string[];
  priority?: number; // Higher priority rules are checked first
}
```

## Built-in Providers

The Migration Advisor comes with built-in providers for:

- **React** (17→18, 18→19)
- **Next.js** (13→14, 14→15)
- **TypeScript** (4→5, 5.4→5.5)
- **ESLint** (8→9)
- **Prettier** (2→3)
- **Jest** (28→29, 29→30)

## Tags

You can organize providers using tags:

- `framework`: React, Next.js, etc.
- `build-tool`: Vite, Webpack, etc.
- `testing`: Jest, Vitest, etc.
- `linting`: ESLint, Prettier, etc.
- `company`: Internal company packages
- `custom`: Custom packages

Search by tags:

```typescript
const frameworkPackages = advisor.searchProvidersByTag("framework");
console.log(frameworkPackages); // ['react', 'next']
```

## Best Practices

1. **Use Priority**: Set higher priority for more specific rules
2. **Include Resources**: Always provide links to documentation
3. **Be Specific**: Include exact code examples in migration instructions
4. **Tag Appropriately**: Use relevant tags for discoverability
5. **Test Rules**: Verify your migration instructions work
6. **Version Patterns**: Use semantic version patterns (1.x.x, 2.x.x)

## Contributing

To add support for a popular package:

1. Create a provider in `src/services/migration-rules/providers/`
2. Add it to the registry in `registry.ts`
3. Export it from `index.ts`
4. Add tests
5. Submit a pull request
