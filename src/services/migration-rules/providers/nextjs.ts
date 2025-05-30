import { MigrationRuleProvider, PackageMigrationInfo } from "../types";

export class NextJsMigrationProvider implements MigrationRuleProvider {
  getPackageName(): string {
    return "next";
  }

  getMigrationInfo(): PackageMigrationInfo {
    return {
      name: "next",
      tags: ["framework", "react", "fullstack"],
      rules: [
        {
          fromVersion: "13.x.x",
          toVersion: "14.x.x",
          priority: 1,
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
          automatedFixes: [
            "Remove experimental flags from next.config.js",
            "Update import paths for moved APIs",
          ],
        },
        {
          fromVersion: "14.x.x",
          toVersion: "15.x.x",
          priority: 1,
          instructions: `## Next.js 15 Migration Guide

### Key Changes:
1. **React 19 Support**: Full support for React 19
2. **Turbopack Stable**: Turbopack is now stable for development
3. **Caching Updates**: New caching behavior for fetch requests

### Migration Steps:
1. Update React to version 19:
   \`\`\`bash
   npm install react@19 react-dom@19
   \`\`\`

2. Enable Turbopack in \`next.config.js\`:
   \`\`\`js
   const nextConfig = {
     experimental: {
       turbo: {
         // Turbopack-specific config
       }
     }
   }
   \`\`\`

3. Review caching behavior for fetch requests

### Resources:
- [Next.js 15 Release Notes](https://nextjs.org/blog/next-15)`,
          breakingChanges: [
            "React 19 breaking changes apply",
            "Caching behavior changes",
            "Some experimental APIs removed",
          ],
        },
      ],
      repositoryUrl: "https://github.com/vercel/next.js",
      changelogUrl: "https://github.com/vercel/next.js/releases",
      documentationUrl: "https://nextjs.org/docs",
    };
  }
}
