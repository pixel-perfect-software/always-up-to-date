# Package Managers - Component Context

## Purpose
Abstraction layer over npm, yarn, pnpm, and bun. Provides a unified interface for checking outdated packages, updating dependencies, and detecting workspace/monorepo configurations.

## Current Status: Stable
All four package managers are fully implemented with workspace support.

## Component-Specific Development Guidelines
- All managers extend `CommandRunner` base class from `src/commandRunner.ts`
- Each manager must implement: `checkPackageVersions()`, `updatePackages()`, `checkIfInWorkspace()`
- The `PackageManager` factory class (`packageManager.ts`) maps `SupportedPackageManager` to concrete instances via switch statement

## Major Subsystem Organization
```
managers/
  packageManager.ts    # Factory: SupportedPackageManager -> concrete manager
  npm/index.ts         # NPMManager
  yarn/index.ts        # YarnManager
  pnpm/index.ts        # PNPMManager
  bun/index.ts         # BunManager
```

## Architectural Patterns

### CommandRunner Base Class (`src/commandRunner.ts`)
- `runCommand(packageManager, command, cwd)` executes `${packageManager} ${command}` via `execAsync`
- Returns stdout on success
- Handles non-zero exit codes that still produce stdout (e.g., `npm outdated` exits non-zero when packages are outdated) by returning stdout if stderr is empty
- Throws on stderr or unknown errors

### Package Detection (`src/detectPackageManager.ts`)
- Scans cwd for lock files in order: npm -> yarn -> pnpm -> bun
- Last match wins if multiple lock files exist
- Lock file mapping: `package-lock.json` (npm), `yarn.lock` (yarn), `pnpm-lock.yaml` (pnpm), `bun.lock` (bun)

### Workspace Detection
| Manager | Method | Flag |
|---------|--------|------|
| npm | `package.json` `workspaces` field (array or `{packages: [...]}`) | `--workspaces` |
| yarn | `package.json` `workspaces` field | `--workspaces` |
| pnpm | `pnpm-workspace.yaml` file existence | `--recursive` |
| bun | `package.json` `workspaces` field | `--workspaces` |

## Integration Points
- `src/commands/check.ts` and `src/commands/update.ts` instantiate managers via the factory
- `src/utils/updateChecker.ts` filters which packages to update (used inside `updatePackages()`)
- `src/utils/packageGrouper.ts` groups check output by scope for display
- `src/utils/files.ts` `updatePackageJson()` writes version updates before running the manager's update command
