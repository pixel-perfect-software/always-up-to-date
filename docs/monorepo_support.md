# Monorepo Support

## Overview

Always Up To Date automatically detects and supports monorepos and workspaces. It works with:

- **npm workspaces**
- **Yarn workspaces**
- **pnpm workspaces**
- **Bun workspaces**

## Auto-Detection

The tool automatically detects monorepos by looking for:

1. `workspaces` field in `package.json` (npm)
2. Lock files to determine package manager

No additional configuration or CLI flags are needed - it just works!

## Current Features

### ✅ Full Package Manager Support

#### npm Workspaces

- Automatically detects npm workspaces from `package.json`
- Uses `--workspaces` flag when running npm commands
- Processes all workspace packages in a single operation

#### Yarn Workspaces

- Automatically detects yarn workspaces from `package.json`
- Uses `--recursive` flag for workspace operations
- Parses yarn's table-based outdated output format

#### pnpm Workspaces

- Automatically detects pnpm workspaces from `pnpm-workspace.yaml`
- Uses `-r` (recursive) flag for workspace operations
- Full support for pnpm's workspace configuration

#### Bun Workspaces

- Automatically detects bun workspaces from `package.json`
- Uses `--filter '*'` for workspace operations
- Parses bun's table-based output format

## Example Usage

### npm Workspaces

```bash
# Works automatically in npm workspace monorepos
cd my-npm-monorepo
autd check
```

For an npm workspace with this structure:

```json
{
  "name": "my-monorepo",
  "private": true,
  "workspaces": ["packages/*", "apps/*"]
}
```

The tool will:

1. Detect the workspace configuration
2. Run `npm outdated --json --workspaces` to check all packages
3. Use `npm update <package> --workspaces` to update across all workspaces

## Package Manager Detection

The tool detects your setup by looking for:

- **npm workspaces** - `package.json` with `workspaces` field + `package-lock.json`
- **yarn workspaces** - `package.json` with `workspaces` field + `yarn.lock`
- **pnpm workspaces** - `pnpm-workspace.yaml` + `pnpm-lock.yaml`
- **bun workspaces** - `package.json` with `workspaces` field + `bun.lock`

## Current Implementation

The current workspace detection logic:

```typescript
// Example from npm manager
const isRunningInWorkspace = await this.checkIfInWorkspace(cwd)
const command = isRunningInWorkspace
  ? "outdated --json --workspaces"
  : "outdated --json"
```

## Directory Structure Examples

### Supported: npm Workspaces

```
my-monorepo/
├── package.json          # Contains "workspaces": ["packages/*"]
├── package-lock.json     # npm lock file
├── packages/
│   ├── core/
│   │   └── package.json
│   └── utils/
│       └── package.json
└── apps/
    └── web/
        └── package.json
```

### Coming Soon: pnpm Workspaces

```
my-monorepo/
├── package.json
├── pnpm-workspace.yaml   # pnpm workspace config
├── pnpm-lock.yaml        # pnpm lock file
└── packages/
    ├── core/
    └── utils/
```

## Benefits

1. **Automatic Detection** - No configuration needed
2. **Unified Updates** - Updates dependencies across all workspace packages
3. **Package Manager Aware** - Uses the correct commands for your setup
4. **Simple Interface** - Same commands work for single packages and workspaces

## Best Practices

1. **Use workspace patterns** consistently in your `package.json`
2. **Test updates** in smaller workspaces first
3. **Keep workspace packages** focused and well-defined
4. **Commit lock files** to maintain consistency

## Limitations

- No workspace-specific configuration yet
- Sequential processing only (no parallel updates)
- Advanced features like version synchronization are planned

## Troubleshooting

### Workspace Not Detected

1. Ensure `package.json` has `workspaces` field for npm
2. Check that `package-lock.json` exists for npm detection
3. Verify workspace patterns match your directory structure
4. Ensure each workspace has a valid `package.json`

### Updates Not Working

1. Verify all workspace packages have valid `package.json` files
2. Check that workspace patterns are correctly defined
3. Ensure you have proper permissions to update all packages

## Roadmap

### Phase 1 (Completed ✅)

- ✅ npm workspace detection and support
- ✅ yarn workspace detection and support
- ✅ pnpm workspace detection and support
- ✅ bun workspace detection and support
- ✅ Basic workspace update commands for all package managers

### Phase 2 (Planned)

- 📋 Workspace-specific configuration
- 📋 Version synchronization across workspaces
- 📋 Parallel workspace processing
- 📋 Advanced workspace rules and patterns
- 📋 Interactive workspace selection
