# Package Managers - Component Context

## Purpose
Abstraction layer over npm, yarn, pnpm, and bun. Provides a unified interface for checking outdated packages, updating dependencies, and detecting workspace/monorepo configurations.

## Current Status: Stable
All four package managers are fully implemented with workspace support.

## Component-Specific Development Guidelines
- All managers extend `CommandRunner` base class from `src/commandRunner.ts`
- Each manager must implement: `checkPackageVersions()`, `updatePackages()`, `checkIfInWorkspace()`
- `checkPackageVersions()` returns `Record<string, PackageInfo>` (structured data)
- `updatePackages()` returns `UpdateResult[]` and accepts optional `targetPackages?: string[]` for scoped updates and `discovered?: Record<string, PackageInfo>` to reuse a discovery result instead of running `outdated` again
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
- `runCommand(packageManager, args, cwd, isSuccess?)` runs the manager with an argument array via `runProcess` and returns stdout. Build `args` as an array (`['update', ...names]`); shell quoting such as `'*'` must not appear in arguments
- Success is decided by a `SuccessCheck` over `{ exitCode, stdout }`; the default is exit 0. stderr is never a failure signal (yarn v1 on Node 24 always prints a DEP0169 warning); it is logged with `logger.debug`
- A failure throws `Command execution failed: <stderr, else stdout>`; a process with no numeric exit code (spawn failure, killed) throws the "unknown error" message. `runCommand` does not log failures; the command layer reports them once
- Managers call `runStep(step, packageManager, args, cwd, { isSuccess?, manifestWritten? })`, which rethrows as a `StepError` tagged `discover` or `apply`. Pass `manifestWritten: true` when autd rewrote package.json before the apply command (npm, pnpm, bun); yarn writes its own manifest, so it passes `false`. `updatePackages()` never catches: failures reach `src/commands/reportFailure.ts`
- Each manager's `outdated` passes its own `isOutdatedReport` check, because npm, pnpm and yarn v1 exit 1 both when packages are outdated and on real errors:

| Manager | `outdated` succeeds when |
|---------|--------------------------|
| npm | exit 0, or exit 1 with a JSON report that is not npm's `{ "error": { code, summary } }` |
| pnpm | exit 0, or exit 1 with a JSON object on stdout (errors leave stdout empty) |
| yarn v1 | exit 0, or exit 1 with a `{"type":"table"}` line (errors have none) |
| bun | exit 0 only (bun exits 0 when packages are outdated) |

Apply commands (`update`, `upgrade`, `install`) use the default.

### Package Detection (`src/detectPackageManager.ts`)
- Scans cwd for lock files in order: npm -> yarn -> pnpm -> bun
- Last match wins if multiple lock files exist
- Lock file mapping: `package-lock.json` (npm), `yarn.lock` (yarn), `pnpm-lock.yaml` (pnpm), `bun.lock` (bun)

### Workspace Detection
| Manager | Method | Flag |
|---------|--------|------|
| npm | `package.json` `workspaces` field (array or `{packages: [...]}`) | `--workspaces` |
| yarn | `package.json` `workspaces` field | `--recursive` (on `outdated` only) |
| pnpm | `pnpm-workspace.yaml` file existence | `-r` |
| bun | `package.json` `workspaces` field + optional `catalog`/`catalogs` | `--filter *` (two arguments) |

## Integration Points
- `src/commands/check.ts` and `src/commands/update.ts` instantiate managers via the factory
- `src/utils/filterPackages.ts` filters and classifies packages for update (used inside `updatePackages()`)
- `src/utils/packageGrouper.ts` groups check output by scope for display
- `src/utils/files.ts` `updatePackageJson()` writes version updates before running the manager's update command (npm, pnpm, bun), only for packages moving past their range

### Discovery: names
Every parser's report goes through `toManifestNames()`, so results are keyed by the package.json name. An `npm:` alias (`"dj": "npm:dayjs@1.11.9"`) otherwise comes back as `dj:dayjs@1.11.9` (npm) or the target name `dayjs` (pnpm, bun); yarn v1 reports `dj` but with `exotic` as wanted and latest, which the policy holds as an invalid version. The managers' own `update dj` accepts the alias key.

### Discovery: `wanted`
Every parser fills `PackageInfo.wanted`, the highest version the manifest range allows: npm's `wanted`, yarn v1's `Wanted` column, bun's `Update` column. pnpm's own `wanted` is the lockfile's version, so pnpm also runs `outdated --compatible` (in parallel) and takes `wanted` from its `latest`.

### Apply: within range vs beyond range
- In-range updates (`target == wanted`) go to the manager by name with no manifest write: `npm update`, `pnpm update`, `bun update`, yarn `upgrade name@<current spec>`. Each manager installs `wanted`; npm and yarn leave package.json alone, pnpm and bun raise the range floor (their own convention)
- Beyond-range updates get their spec rewritten to the target first (decorator kept), then the same command
- pnpm workspaces run `install` after manifest/catalog writes, then `update -r <in-range names>`; bun catalogs the same with `install` then `update <names> --filter *`

### Yarn apply (`src/managers/yarn/index.ts`)
- yarn writes the manifest itself: autd passes `name@spec` descriptors from `buildUpdateDescriptors()` and never pre-writes `package.json` (v1 then fails with "Outdated lockfile")
- v1 runs `yarn upgrade <descriptors>`, berry runs `yarn up <descriptors>`; neither has `update`. No `--recursive` on apply: v1 has no such flag and berry's rejects explicit ranges
- A bare `yarn up name` on berry rewrites an exact pin to `^`, so descriptors always carry the spec
- `isBerry(cwd)` is `isYarnBerry` from `src/detectPackageManager.ts` (also used for override detection): `packageManager: yarn@2+` wins; otherwise a `.yarnrc.yml` means berry
- Packages missing from the root manifest are skipped with a warning: v1 `upgrade` at a workspace root adds them as root dependencies
- Berry has no `outdated`, so discovery (and therefore `check`/`update`) does not run on berry yet
