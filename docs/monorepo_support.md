# Monorepo Support

This document describes the monorepo features added to `always-up-to-date`.

## Overview

`always-up-to-date` now automatically detects and supports monorepos using standard workspace patterns. It works seamlessly with:

- **npm workspaces**
- **Yarn workspaces**
- **pnpm workspaces**
- **Lerna** (via workspace patterns)
- **Nx** (via workspace patterns)

## Auto-Detection

The tool automatically detects monorepos by looking for:

1. `workspaces` field in `package.json` (npm/yarn)
2. `pnpm-workspace.yaml` file (pnpm)
3. Lock files to determine package manager

No additional configuration or CLI flags are needed - it just works!

## Key Features

### 🔄 Version Synchronization

- Automatically syncs dependency versions across all workspaces
- Detects and reports version conflicts
- Ensures consistent dependency versions throughout the monorepo

### 📦 Workspace-Aware Updates

- Processes all workspaces automatically
- Skips internal workspace dependencies
- Handles cross-workspace impact analysis

### 🔀 Separate PRs Per Workspace

- Creates individual PRs for each workspace by default
- Clear, focused changes per workspace
- Easy to review and manage

### ⚙️ Flexible Configuration

- Workspace-specific rules and settings
- Pattern-based workspace targeting
- Inherit from root configuration with overrides

## Example Usage

```bash
# Works automatically in any monorepo
cd my-monorepo
alwaysuptodate check
```

**Output:**

```
📦 Detected monorepo with 5 packages

Workspace: @myapp/frontend
  - react: 17.0.2 → 18.2.0 (breaking changes)
  - lodash: 4.17.20 → 4.17.21 ✅

Workspace: @myapp/backend
  - express: 4.17.1 → 4.18.2 ✅
  - lodash: 4.17.20 → 4.17.21 ✅ (synced across workspaces)

⚠️  Version conflicts detected:
  lodash: 4.17.20, 4.17.21
```

## Configuration

### Basic Workspace Config

```json
{
  "workspace": {
    "processAllWorkspaces": true,
    "syncVersionsAcrossWorkspaces": true,
    "createSeparatePRsPerWorkspace": true,
    "updateInternalDependencies": false,
    "maintainWorkspaceVersionSync": true
  }
}
```

### Workspace-Specific Rules

```json
{
  "workspace": {
    "workspaceRules": [
      {
        "pattern": "@myapp/frontend*",
        "ignoredPackages": ["webpack"],
        "updateStrategy": "minor",
        "autoUpdate": false
      },
      {
        "pattern": "@myapp/backend*",
        "updateStrategy": "patch",
        "autoUpdate": true
      },
      {
        "pattern": "*-tools",
        "ignoredPackages": ["eslint"],
        "updateStrategy": "minor"
      }
    ]
  }
}
```

### Pattern Matching

Workspace rules support glob-style patterns:

- `@myapp/*` - Matches all packages in @myapp scope
- `*-frontend` - Matches packages ending with -frontend
- `tools-*` - Matches packages starting with tools-
- `@company/app-*` - Matches scoped packages with prefix

## Configuration Options

| Option                          | Description                         | Default |
| ------------------------------- | ----------------------------------- | ------- |
| `processAllWorkspaces`          | Process all detected workspaces     | `true`  |
| `syncVersionsAcrossWorkspaces`  | Keep versions synchronized          | `true`  |
| `createSeparatePRsPerWorkspace` | Create individual PRs per workspace | `true`  |
| `updateInternalDependencies`    | Update internal workspace deps      | `false` |
| `maintainWorkspaceVersionSync`  | Maintain version consistency        | `true`  |

## Workspace Rules

Each workspace rule can specify:

- `pattern` - Glob pattern to match workspace names
- `ignoredPackages` - Packages to ignore for this workspace
- `updateStrategy` - Update strategy (`major`, `minor`, `patch`, `none`)
- `autoUpdate` - Whether to auto-update packages

## Supported Monorepo Tools

### npm/Yarn Workspaces

```json
{
  "name": "my-monorepo",
  "private": true,
  "workspaces": ["packages/*", "apps/*"]
}
```

### pnpm Workspaces

```yaml
# pnpm-workspace.yaml
packages:
  - "packages/*"
  - "apps/*"
  - "tools/*"
```

### Lerna

```json
{
  "packages": ["packages/*"],
  "version": "independent"
}
```

## Backward Compatibility

- Single-package projects continue to work unchanged
- All existing configuration options are preserved
- No breaking changes to existing functionality

## Version Conflict Detection

The tool automatically detects when different workspaces use different versions of the same dependency:

```
⚠️  Version conflicts detected across workspaces:
  lodash: ^4.17.20, ^4.17.21
  react: ^17.0.0, ^18.0.0
```

When `syncVersionsAcrossWorkspaces` is enabled, all workspaces will be updated to use the same (latest) version.

## Internal Dependencies

Internal workspace dependencies (packages within the monorepo) are:

- Automatically detected and excluded from updates
- Not considered for version synchronization
- Handled separately from external dependencies

## PR Creation Strategy

With `createSeparatePRsPerWorkspace: true`:

- Each workspace gets its own PR
- PR titles: `chore(workspace-name): update dependencies`
- Clear separation of concerns
- Easier review and testing per workspace

Example PRs:

- `chore(@myapp/frontend): update dependencies`
- `chore(@myapp/backend): update dependencies`
- `chore(@myapp/shared-utils): update dependencies`

## Best Practices

1. **Use workspace rules** for different update strategies per workspace type
2. **Enable version sync** to maintain consistency
3. **Create separate PRs** for easier review and testing
4. **Ignore internal deps** to avoid circular updates
5. **Test in dry-run mode** first with large monorepos

## Migration from Single Package

No migration needed! The tool automatically detects monorepos and enables workspace features. Your existing configuration continues to work as the base configuration for all workspaces.

## Limitations

- Does not currently support parallel processing (sequential for reliability)
- Internal dependency updates are disabled by default
- Complex dependency graphs may require manual intervention

## Troubleshooting

### Workspace Not Detected

1. Ensure `package.json` has `workspaces` field or `pnpm-workspace.yaml` exists
2. Check workspace patterns match your directory structure
3. Verify each workspace has a valid `package.json`

### Version Conflicts

1. Review conflicting versions in the output
2. Enable `syncVersionsAcrossWorkspaces` to auto-resolve
3. Add specific version rules for problematic packages

### Performance Issues

1. Use `batchSize` to limit concurrent operations
2. Consider workspace-specific rules to reduce scope
3. Use `dryRun` mode for testing configuration changes
