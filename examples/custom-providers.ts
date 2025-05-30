import {
  MigrationRuleProvider,
  PackageMigrationInfo,
} from "../src/services/migration-rules/types";

/**
 * Example custom migration provider for a company-specific package
 */
export class CustomPackageMigrationProvider implements MigrationRuleProvider {
  getPackageName(): string {
    return "my-company-ui-lib";
  }

  getMigrationInfo(): PackageMigrationInfo {
    return {
      name: "my-company-ui-lib",
      tags: ["ui", "company", "design-system"],
      rules: [
        {
          fromVersion: "3.x.x",
          toVersion: "4.x.x",
          priority: 1,
          instructions: `## Company UI Library Migration: 3.x → 4.x

### Key Changes:
1. **Design Tokens**: New design token system
2. **Component API**: Unified component props
3. **Theming**: New theming architecture

### Migration Steps:
1. Update design tokens:
   \`\`\`js
   // Before
   import { colors } from 'my-company-ui-lib/tokens';

   // After
   import { designTokens } from 'my-company-ui-lib/design-system';
   \`\`\`

2. Update component usage:
   \`\`\`jsx
   // Before
   <Button color="primary" size="large">Click me</Button>

   // After
   <Button variant="primary" size="lg">Click me</Button>
   \`\`\`

3. Update theme configuration
4. Run the automated codemod:
   \`\`\`bash
   npx @my-company/ui-lib-codemod v3-to-v4
   \`\`\`

### Company Resources:
- Design System Documentation: https://design.company.com
- Migration Slack Channel: #ui-lib-migration
- Office Hours: Tuesdays 2-3pm PST`,
          breakingChanges: [
            "Design token naming convention changed",
            "Component prop names updated",
            "Theme structure refactored",
            "Some components removed or consolidated",
          ],
          automatedFixes: [
            "Run codemod for component updates",
            "Update design token imports",
            "Convert theme configurations",
          ],
        },
        {
          fromVersion: "4.x.x",
          toVersion: "5.x.x",
          priority: 1,
          instructions: `## Company UI Library Migration: 4.x → 5.x

### Key Changes:
1. **React 19 Support**: Full React 19 compatibility
2. **CSS-in-JS**: Migration to new styling solution
3. **Accessibility**: Enhanced a11y features

### Migration Steps:
1. Update React to version 19
2. Update styling approach:
   \`\`\`js
   // Before
   import { styled } from 'my-company-ui-lib/styled';

   // After
   import { css } from 'my-company-ui-lib/styling';
   \`\`\`

3. Review accessibility updates
4. Test with screen readers

### Resources:
- React 19 Migration: Internal wiki
- Styling Migration Guide: Design system docs`,
          breakingChanges: [
            "React 19 requirement",
            "Styling system changed",
            "Some accessibility props updated",
          ],
        },
      ],
      repositoryUrl: "https://github.com/my-company/ui-lib",
      changelogUrl: "https://github.com/my-company/ui-lib/releases",
      documentationUrl: "https://design.company.com",
    };
  }
}

/**
 * Example provider for a third-party package with custom rules
 */
export class ViteMigrationProvider implements MigrationRuleProvider {
  getPackageName(): string {
    return "vite";
  }

  getMigrationInfo(): PackageMigrationInfo {
    return {
      name: "vite",
      tags: ["build-tool", "bundler", "development"],
      rules: [
        {
          fromVersion: "4.x.x",
          toVersion: "5.x.x",
          priority: 1,
          instructions: `## Vite 5 Migration Guide

### Key Changes:
1. **Node.js 18+**: Requires Node.js 18 or higher
2. **Rollup 4**: Updated to Rollup 4
3. **API Changes**: Some APIs deprecated

### Migration Steps:
1. Update Node.js to version 18+
2. Update vite.config.js:
   \`\`\`js
   // Check for deprecated options
   export default {
     // Update any deprecated configurations
   }
   \`\`\`

3. Update plugins to compatible versions
4. Test build process thoroughly

### Resources:
- [Vite 5 Migration Guide](https://vitejs.dev/guide/migration.html)`,
          breakingChanges: [
            "Node.js version requirement",
            "Rollup 4 breaking changes",
            "Deprecated APIs removed",
          ],
          automatedFixes: [
            "Update vite.config.js format",
            "Update plugin configurations",
          ],
        },
      ],
      repositoryUrl: "https://github.com/vitejs/vite",
      changelogUrl: "https://github.com/vitejs/vite/releases",
      documentationUrl: "https://vitejs.dev",
    };
  }
}
