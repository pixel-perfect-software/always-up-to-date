# Test Monorepo for Always Up To Date

This is a test monorepo to verify the monorepo support functionality of the `always-up-to-date` CLI tool.

## Structure

```
test-monorepo/
├── packages/
│   ├── shared-utils/          # Common utilities (lodash ^4.17.20, axios ^1.4.0)
│   └── ui-components/         # React components (react ^17.0.2, lodash ^4.17.21)
├── apps/
│   ├── web-app/              # Next.js web app (react ^18.2.0, next ^13.4.8)
│   └── mobile-app/           # React Native app (react-native ^0.72.3, lodash ^4.17.19)
└── .alwaysuptodate.json      # Configuration with workspace rules
```

## Test Scenarios

This monorepo is designed to test:

1. **Monorepo Detection**: Should auto-detect as npm workspaces monorepo
2. **Version Conflicts**: lodash has different versions across workspaces (^4.17.19, ^4.17.20, ^4.17.21)
3. **React Version Conflicts**: React versions differ between packages (^17.0.2 vs ^18.2.0)
4. **Internal Dependencies**: Packages reference each other (@test-monorepo/*)
5. **Workspace-Specific Rules**: Different update strategies per workspace
6. **Breaking Changes**: Some packages have major version updates available
7. **Root Dependencies**: Root has dev dependencies (typescript, eslint, prettier)

## Expected CLI Behavior

- Should detect 5 packages total (root + 4 workspaces)
- Should report version conflicts for lodash and react
- Should respect workspace-specific rules from config
- Should skip internal dependencies (@test-monorepo/*)
- Should suggest updates for outdated packages
- Should handle breaking changes appropriately
