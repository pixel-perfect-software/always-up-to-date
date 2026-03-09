# Utilities - Component Context

## Purpose
Shared utilities for configuration management, update logic, logging, file operations, and package grouping.

## Current Status: Stable
Core utilities fully implemented. Central barrel export via `index.ts`.

## Component-Specific Development Guidelines
- All exports consolidated through `src/utils/index.ts` barrel file
- `execAsync` (promisified `exec`) is re-exported here for use by `CommandRunner`
- Config uses nullish coalescing with `DEFAULT_CONFIG` for safe merging

## Major Subsystem Organization
```
utils/
  index.ts            # Barrel: re-exports execAsync, config, logger, filterPackages, packageGrouper, updateChecker, files
  config.ts           # loadConfig(), saveJsonConfig(), DEFAULT_CONFIG
  updateChecker.ts    # Semver-based update filtering (single package)
  filterPackages.ts   # Batch filtering with targeting support, returns UpdateResult[]
  packageGrouper.ts   # Groups packages by @scope for display
  logger.ts           # Colored logging (colorette)
  files.ts            # checkIfFileExists(), updatePackageJson(), updatePNPMWorkspaceYAML(), updateBunCatalogs(), identifyCatalogPackages()
```

## Architectural Patterns

### Configuration (`config.ts`)
- Config file: `.always-up-to-date.json` in project root
- `loadConfig(workingDir?)` reads JSON, merges with `DEFAULT_CONFIG`
- `saveJsonConfig(config, filePath)` writes formatted JSON
- Schema: `AlwaysUpToDateConfig` (see `src/types.ts`)

### Update Logic (`updateChecker.ts`)
Priority order:
1. Invalid semver -> reject
2. In `updateAllowlist` -> always allow
3. In `updateDenylist` -> always reject
4. No version diff -> reject
5. By type: `patch` always allowed, `minor` if `allowMinorUpdates`, `major` if `allowMajorUpdates`
6. `allowMajorUpdates: true` implicitly enables minor updates

### Package Grouping (`packageGrouper.ts`)
Groups packages by `@scope/` prefix. Unscoped packages go to a default group. Groups sorted alphabetically.

### Package Filtering (`filterPackages.ts`)
- Wraps `updateChecker` for batch operations across all outdated packages
- Returns `UpdateResult[]` with name, current, latest, updateType, updated (boolean), and reason
- Accepts optional `targetPackages` array to scope updates to specific packages
- Used by all manager `updatePackages()` methods, dry-run, and interactive mode

## Integration Points
- `src/commandRunner.ts` uses `execAsync` and `logger`
- `src/managers/*/index.ts` use `filterPackages`, `logger`, `groupAndSortPackages`, `updatePackageJson`
- `src/commands/update.ts` uses `filterPackages` for dry-run and interactive mode
- `src/commands/init.ts` uses `saveJsonConfig` and `DEFAULT_CONFIG`
