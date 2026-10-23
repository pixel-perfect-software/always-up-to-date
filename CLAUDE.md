# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Always Up To Date is a CLI tool that automatically keeps dependencies up to date with intelligent package manager detection and workspace support. It supports npm, yarn, pnpm, and bun.

## Development Commands

### Build and Type Checking
- `pnpm run build` - Compile TypeScript and resolve path aliases (requires both `tsc` and `tsc-alias`)
- `pnpm run check-types` - Type check without emitting files
- `pnpm run clean` - Remove the dist directory

### Testing
- `pnpm test` - Run all tests (silent mode)
- `pnpm run test:coverage` - Run tests with coverage report
- `pnpm run test:integration` - The integration matrix: builds, then runs the built CLI against real npm, pnpm, yarn v1, yarn berry and bun on temp copies of `testRepos/`. Needs network access and the managers on PATH (yarn through Corepack: `corepack enable yarn`). Outside `pnpm test` and coverage. `AUTD_INTEGRATION_PM=npm,bun` selects managers (an unknown name fails fast); `AUTD_INTEGRATION_KEEP=1` keeps the temp copies and prints their paths
- `pnpm run test:badges` - Regenerate the coverage badges in `./badges`, shown in the README. They are static files: rerun and commit them when coverage changes
- Single test: `pnpm test -- __tests__/path/to/test.test.ts`

### Code Quality
- `pnpm run format-and-lint` - Check formatting and linting with Biome
- `pnpm run format-and-lint:fix` - Auto-fix formatting and linting issues with Biome

### Local Development
- `pnpm run init` - Initialize config in the current directory
- `pnpm run check-deps` - Check for outdated dependencies
- `pnpm run update-deps` - Update dependencies
- After building, the CLI can be tested locally with: `node dist/index.js <command>`

### Releasing
- `/ship:release <major|minor|patch>` bumps `version` in `package.json` and adds the version's `CHANGELOG.md` entry (`## <date> — <version>: <headline>`) in a `Release <version>` PR
- Once that merges, pushing a `v<version>` tag on `main` runs `.github/workflows/release.yml`. It checks that the tag matches `package.json`, sits on `main` and has a `CHANGELOG.md` entry, runs the gates, publishes with `pnpm publish`, and creates the GitHub release with that entry as its notes. pnpm, not npm: it writes the `catalog:` ranges as real versions in the published manifest
- npm authenticates the publish through trusted publishing (OIDC); no token is stored in the repository. The workflow is registered as the package's trusted publisher on npmjs.com, so renaming `release.yml` breaks publishing until that setting is updated
- Don't publish from a local checkout: `prepack` builds over `dist/` without cleaning it, so files left from another branch ship

## Architecture

### Core Components

**Pipeline and manager adapters**
- `src/pipeline.ts` runs detect → discover → plan → apply → report once for every manager:
  - `check(project)` - Returns `Record<string, PackageInfo>` of outdated packages, keyed by package.json name, and prints them
  - `plan(project, outdated, targetPackages?)` - The policy's `UpdateResult[]` (dry-run, interactive)
  - `update(project, { targetPackages?, discovered? })` - Plans, applies, returns `UpdateResult[]`. `discovered` is a `check` result the caller already has, so discovery is not run twice. After apply, each moving dependency is checked against what the manager installed (`src/utils/installed.ts` reads `node_modules`; an adapter with `installed()`, yarn berry under PnP, answers from the manager instead): one the manager left below its target is reported `updated: false`, `not applied by <pm> (installed <version>)`
- Each manager is an adapter (`src/managers/<pm>/index.ts`, interface in `src/managers/adapter.ts`) holding only what is specific to it: `lockfile`, `readWorkspace`, `discover` (with an exported pure parser), `apply`, optionally `installed`, `saveStyle`, `overrides`. A new manager is its adapter, its registry entry in `src/managers/index.ts`, and its fixtures
- `src/project.ts` `openProject(cwd, { pm? })` builds the `Project` (`{ cwd, config, adapter }`) once per command run: `loadConfig(cwd)`, then `logger.configure(config)`, then detection. The pipeline reads `project.config`; nothing below a command loads the config again
- `src/detectPackageManager.ts` picks the manager: `--pm`, then package.json `packageManager`, then `devEngines.packageManager`, then the adapters' lockfiles (package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock; with several, the last wins and a warning names it). A lockfile that disagrees with the declared manager is logged at debug level; `adapterFor(name)` returns the adapter

**Command Runner Pattern**
- `src/commandRunner.ts` provides `runCommand()` / `runStep()`; the pipeline hands adapters a `run` bound to the step
- Executes package manager commands via `runProcess` (`src/utils/runProcess.ts`): `execFile` with an argument array, no shell, no output cap. Commands are always built as arrays, never strings
- Success is judged per call by exit code plus parsable stdout (a `SuccessCheck`), never by stderr, which is logged at debug level
- All manager commands go through this abstraction for consistency
- Failures propagate as a `StepError` (`src/stepError.ts`, step `detect` / `discover` / `apply`) to the command, which reports once and exits 1; never catch and return an empty result

**Configuration System**
- Config file: `.always-up-to-date.json` in the project root
- Loaded once per command run by `openProject()` (`src/project.ts`) via `loadConfig()` in `src/utils/config.ts`, then passed down as `project.config`. `--help`, `--version` and `init` never read it; a malformed file fails `check` / `update` through `reportFailure`
- A JSON schema at `schema/config.schema.json` is referenced via `$schema` in the file generated by `init` for IDE autocomplete/validation
- Supports:
  - Default policy: stay within each package.json range (move to `wanted`); an exact pin is held
  - `beyondRange` - `"none"` (default) | `"patch"` | `"minor"` | `"major"`: how far past its range a package may move (to `latest`), exact pins included
  - `rules` - Per package or `*` glob: `"hold"`, `"followRange"`, `"latest"`. Exact name beats glob; longest glob wins
  - Deprecated, still read: `allowMinorUpdates` / `allowMajorUpdates` (→ `beyondRange`), `updateAllowlist` / `updateDenylist` (→ `latest` / `hold` rules). The new fields win when both are set
  - Overrides the manager enforces (`src/utils/overrides.ts`) beat everything: a target outside an override's range is held as `controlled by …`
  - A target an installed package's peer range excludes is held (`src/utils/peers.ts`, `peer conflict: …`); a `latest` rule moves anyway and sets `UpdateResult.warning`
- Support the current version of each manager only; verify its behavior with a real run rather than reading fields older versions honored
  - `debug` / `silent` - Logging control
  - `cooldown` - Hold off on suggesting freshly-published versions. Accepts a number (days), a duration string (`"1 week"`, `"24h"`), or a per-update-type object (`{ patch, minor, major }` whose values can be either form). Defaults to `0` (disabled).
- `src/utils/updateChecker.ts` is the pure update policy: `updateChecker(info, policy)` returns a `target` or a hold `reason`; `policyFromConfig()` builds the policy
- `src/utils/filterPackages.ts` (async) runs the policy and the cooldown gate (on the target) per package, returns `UpdateResult[]` with `wanted`, `target`, update type, reason, and optional `releaseAge`; `splitUpdates()` separates in-range from beyond-range updates
- `PackageInfo.wanted` is the highest version the manifest range allows; every manager parser fills it
- `src/utils/cooldown.ts` decides if a release is too fresh given its update type
- `src/utils/duration.ts` parses human-readable duration strings into days
- `src/utils/registry.ts` fetches version timestamps via `npm-registry-fetch` (cached per run, fails open on network errors)
- `src/utils/npmrcLoader.ts` reads `.npmrc` (project + `~/.npmrc`) and `NPM_CONFIG_*` env vars into a `RegistryConfig`. Yarn berry's `.yarnrc.yml` and Bun's `bunfig.toml` are not read in v1.

**CLI Structure**
- Entry point: `src/index.ts` → `src/cli.ts`
- Uses Commander.js for command parsing
- Commands registered in `src/commands/`:
  - `init` - Creates `.always-up-to-date.json`
  - `check` - Lists outdated dependencies. Supports `--json` for structured output.
  - `check` and `update` take `--pm <npm|yarn|pnpm|bun>` to skip detection
  - With `--json`, stdout is only the JSON document (`logger.setJsonOutput`); human output goes through `logger`, never `console.log`
  - `update [packages...]` - Updates packages respecting config. Supports `--dry-run` (preview), `-i/--interactive` (checklist selection), `--json` (structured output), and optional package name arguments for targeted updates.
  - `help` - Shows help information
- Binary aliases: `autd`, `alwaysuptodate`, `always-up-to-date`

**Workspace Detection**
- npm/yarn/bun: Checks `package.json` for `workspaces` field (array or object with packages)
- pnpm: Checks for `pnpm-workspace.yaml` file with a `packages:` list
- `Workspace.manifests` lists the root and each member (`src/managers/workspaces.ts`). Discovery keeps the owning manifest of every outdated entry (`Discovery` in `src/managers/adapter.ts`); `check --json` values gain `workspaces: [{ path, current, wanted }]`
- When detected, commands append workspace flags (`-r` for pnpm, `--filter *` for bun, `--recursive` for yarn v1's `outdated`); npm's discovery uses `outdated --json --long` and reads each row's `dependedByLocation`
- Apply writes the manifest that owns each beyond-range row (`updatePackageJson` per manifest; a `catalog:` spec writes the catalog instead). npm, pnpm and bun run one workspace-wide update command; yarn v1 runs `workspace <name> upgrade` per member, then `install`; yarn berry (2+, same adapter, `src/managers/yarn/berry.ts`) has no `outdated`, so it discovers from `yarn info -A --json` plus `yarn npm info`, writes beyond-range specs itself, then `install` and `up -R <in-range names>`

**Package Grouping**
- `src/utils/packageGrouper.ts` groups packages by scope (@org/package) for organized output
- Improves readability when checking many outdated packages

### Future Components (In Development)

**Migrators** (`src/migrator/`)
- Framework-specific migration rules for major version upgrades
- Example rules exist for React 18/19 and Next.js 14/15
- Will provide codemod-like transformations for breaking changes

**PR Generators** (`src/prGenerator/`)
- Automated pull request creation with migration guides
- Planned GitHub integration via @octokit/rest

## Path Aliases

TypeScript paths are configured with `@/*` mapping to `src/*`:
- Import as: `import { logger } from "@/utils"`
- Build process uses `tsc-alias` to resolve aliases in emitted JavaScript

## Engine Requirements

- Node.js: >=24.0.0
- pnpm: >=10.0.0

## Documentation System

This project uses a 3-tier AI-optimized context system:
- **Tier 1 (Foundational)**: This file (`CLAUDE.md`) - project overview and dev commands
- **Tier 2 (Component-Level)**: `CONTEXT.md` files co-located in `src/` component directories
- **Tier 3 (Feature-Specific)**: `CONTEXT.md` files in feature subdirectories (added as needed)

Documentation registry: `.claude/context/ai-context/docs-overview.md`

## Testing Notes

- Test framework: Jest with `@swc/jest` as the transform
- Tests located in `__tests__/` directory (mirrors `src/` structure)
- Global setup: `__tests__/setup.ts` (suppresses console output unless `DEBUG` env is set)
- Test timeout: 15 seconds
- Uses ESM transform for TypeScript
- Mock cleanup: `clearMocks` and `restoreMocks` enabled
- Path aliases: `moduleNameMapper` maps `@/*` to `src/*` for test imports
- Manager tests feed real captured package-manager output from `__tests__/fixtures/<pm>/` (helpers `readFixture`, `exitError` in `__tests__/fixtures/index.ts`). Capture new fixtures from a real run, with local paths scrubbed; never hand-write manager output
- Single test: `pnpm test -- __tests__/path/to/test.test.ts`
- `testRepos/<manager>-<layout>/` are the integration matrix's fixtures (see `testRepos/README.md`): small manifests on frozen release lines, no lockfiles. The harness (`__tests__/integration/`) installs each range at its minimum, restores the ranges, rewrites the lockfile to agree (`lockfiles.ts`), then asserts autd's `check --json`, `update --dry-run --json` and `update --json` against values derived in `expectations.ts`. Manager quirks the matrix observes are per-manager overrides there, each with a comment
- CI runs the unit suite on ubuntu and windows (Biome and the type check only on ubuntu). `.gitattributes` keeps every file LF so Windows checkouts match. Tests that spawn a fake manager use `writeNodeShim` and `prependPath` from `__tests__/fixtures` (a `sh` wrapper on POSIX, a cmd-shim `.cmd` on Windows); symlinks in tests use type `'junction'`, which Windows allows without privileges
