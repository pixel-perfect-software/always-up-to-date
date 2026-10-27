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
- `pnpm run test:integration` - The integration matrix: builds, then runs the built CLI against real npm, pnpm, yarn v1, yarn berry and bun on temp copies of `testRepos/`. Needs network access and the managers on PATH (yarn through Corepack: `corepack enable yarn`). Outside `pnpm test` and coverage. `AUTD_INTEGRATION_PM=npm,bun` selects managers (an unknown name fails fast); `AUTD_INTEGRATION_KEEP=1` keeps the temp copies and prints their paths. CI runs it per manager on ubuntu-latest and windows-latest
- `pnpm run bench` - The benchmark behind the roadmap's perf gates: builds, copies `bench/pinned/` (40 dependencies, each an exact old version; the baseline project) to a temp dir per manager, installs it, then times with hyperfine 2+ (needs it on PATH, plus network and Corepack for yarn) and prints two tables: `check` warm, cold (the manager's own cache emptied before each run), and warm with `cooldown: 7`, with peak memory, per manager, then `autd --version` against bare `node -e 0`. A manager that fails is shown as a failed row, its error printed under the tables, and the exit code is 1. Rows: npm, pnpm, yarn v1, yarn berry under PnP (`berry`) and with the node-modules linker (`berry-nm`), bun. macOS and Linux only; outside `pnpm test` and coverage. `AUTD_BENCH_PM=npm,bun` selects rows (an unknown name fails fast); `AUTD_BENCH_RUNS=n` sets the timed runs of each `check` measurement; `AUTD_BENCH_CLI=/path/to/other/dist/index.js` times another build, so a branch can be compared with `main`; `AUTD_BENCH_PROJECT=ranges` uses `bench/ranges/` (12 of the 40 on `^`/`~`); `AUTD_BENCH_KEEP=1` keeps the temp copies and prints their paths. What cold empties is `coldCaches` in `bench/targets.ts`: add autd's own cache there when it has one
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
- `src/pipeline.ts` runs detect → discover → plan → apply → report once for every manager. Discovery is `discoverFromRegistry` (`src/discovery.ts`) for npm, pnpm, yarn v1 and bun: no manager subprocess, it reads the manifests, `node_modules` and the registry reader; yarn berry alone discovers through its adapter's `ownDiscovery` until #107:
  - `check(project)` - Returns `Record<string, PackageInfo>` of outdated packages, keyed by package.json name, and prints them
  - `plan(project, outdated, targetPackages?)` - The policy's `UpdateResult[]` (dry-run, interactive)
  - `update(project, { targetPackages?, discovered? })` - Plans, applies, returns `UpdateResult[]`. `discovered` is a `check` result the caller already has, so discovery is not run twice. After apply, each moving dependency is checked against what the manager installed (`src/utils/installed.ts` reads `node_modules`; an adapter with `installed()`, yarn berry under PnP, answers from the manager instead): one the manager left below its target is reported `updated: false`, `not applied by <pm> (installed <version>)`
- Each manager is an adapter (`src/managers/<pm>/index.ts`, interface in `src/managers/adapter.ts`) holding only what is specific to it: `lockfile`, `readWorkspace` (with the catalog contents), `apply`, optionally `installed`, `saveStyle`, `overrides`, `npmrcLayers` (the `.npmrc` layers it reads; npm's when absent), `registryConfig` (adjusts the registry config for a manager's own files, bun and yarn v1) and `ownDiscovery` (yarn berry only, until #107). Discovery is not an adapter concern: no adapter parses a manager's `outdated`. A new manager is its adapter, its registry entry in `src/managers/index.ts`, and its apply fixtures
- `src/project.ts` `openProject(cwd, { pm? })` builds the `Project` (`{ cwd, config, adapter, registry }`) once per command run: `loadConfig(cwd)`, then `logger.configure(config)`, then detection. The pipeline reads `project.config`; nothing below a command loads the config again. `registry` is a lazy `RegistrySession` (nothing is read or loaded until it is used); `check` and `update` close it in a `finally`
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
  - `depsDev` - `true` (default) or `false`, validated strictly (`"false"` is an error, not `true`). It takes effect in discovery (every public npm name is looked up at deps.dev unless it is `false`). Only names on registry.npmjs.org or registry.yarnpkg.com are ever sent to deps.dev; no credentials are
  - `debug` / `silent` - Logging control
  - `cooldown` - Hold off on suggesting freshly-published versions. Accepts a number (days), a duration string (`"1 week"`, `"24h"`), or a per-update-type object (`{ patch, minor, major }` whose values can be either form). Defaults to `0` (disabled).
- `src/discovery.ts` `discoverFromRegistry()` is the native discovery for npm, pnpm, yarn v1 and bun, with no manager subprocess:
  - `readDeclaredDependencies` (`src/utils/dependencySpecs.ts`) reads `dependencies`, `devDependencies` and `optionalDependencies` of the root and every member, first field wins; `peerDependencies`-only names are not discovered. `classifySpec` skips specs that never reach the registry (`workspace:`, git, file, link, URL, github shorthand, bare `npm:x`; each with a debug line), resolves `catalog:` through `Workspace.catalogs`, looks an `npm:` alias up by its target (the row keeps the alias's key), and warns for another dist-tag
  - installed versions come from `node_modules` (`readInstalledPackages`); a symlink or junction to a directory inside the project (a workspace member) is skipped, a missing dependency is a `current: 'missing'` row, a missing optional one is skipped. With a registry dependency declared and no `node_modules`, discovery fails with a `discover` `StepError` telling the user to run `<pm> install` (#107 replaces this with lockfile reading)
  - versions come from `RegistrySession.lookup`, one per unique name. A failed lookup fails the run: after every lookup settles, one `discover` `StepError` names each failed package with its reason (the first 10, then "and N more")
  - a row is listed when `current` is `missing`, or `latest` or `wanted` is ahead of `current`. Single-package keys and workspace entries are sorted by name (workspace: then root first, then path)
- `src/utils/updateChecker.ts` is the pure update policy: `updateChecker(info, policy)` returns a `target` or a hold `reason`; `policyFromConfig()` builds the policy
- `src/utils/filterPackages.ts` (async) runs the policy and the cooldown gate (on the target) per package, returns `UpdateResult[]` with `wanted`, `target`, update type, reason, and optional `releaseAge`; `splitUpdates()` separates in-range from beyond-range updates
- `PackageInfo.wanted` is the highest version the manifest range allows: `wantedVersion()` (`src/utils/wanted.ts`) computes it per manifest, the same rule for npm, pnpm, yarn v1 and bun (an exact pin is its own; else `latest` if it satisfies the range and isn't deprecated; else the highest non-deprecated satisfying version; else the highest satisfying one). Berry computes its own from `yarn npm info`
- `src/utils/cooldown.ts` decides if a release is too fresh given its update type
- `src/utils/duration.ts` parses human-readable duration strings into days
- `src/utils/npmrc.ts` is the `.npmrc` parser (ini 7's decode plus a `Substitute` for `${VAR}`: npm's by default, where an unset `${VAR}` stays literal). `src/utils/npmrcLoader.ts` models a manager's `.npmrc` view as layers, highest first (`NpmrcLayer`: an env layer or a file layer), merged per key with each key's origin (`mergeNpmrcLayers` → `NpmrcView`). An adapter's `npmrcLayers(cwd, sources)` supplies them; without it, `npmNpmrcLayers`. A layer never throws: an unreadable file is empty
  - npm: `npm_config_*` env, project `.npmrc` (a workspace member uses the root's), user, global, builtin, `${VAR}` expanded everywhere
  - pnpm 12 (`src/managers/pnpm/npmrc.ts`): `pnpm_config_*` env, `npm_config_*` credentials only, project `pnpm-workspace.yaml` routes, global `config.yaml` routes, project `.npmrc`, global `auth.ini`, then the user file (`pnpm_config_userconfig`, else `npm_config_userconfig`, else `~/.npmrc`). The project files never expand `${…}` (an entry holding one is left out); the user and global files expand `${VAR}` and `${VAR:-default}`. The global directory is `$XDG_CONFIG_HOME/pnpm`, else `~/Library/Preferences/pnpm` on macOS (Linux and Windows are read from pnpm's source)
  - bun 1.4 (`src/managers/bun/npmrc.ts`): the project `.npmrc` (the workspace root's from a member; no parent's), then one user file: `NPM_CONFIG_USERCONFIG`, else `npm_config_userconfig` (cwd-relative, `~/` expanded; it replaces the two below), else `$XDG_CONFIG_HOME/.npmrc` when anything exists there (an empty file or a directory included; an absolute XDG only), else `~/.npmrc`. No `npm_config_*` layer and no npm global or builtin file. `${VAR}` expands anywhere and `$VAR` only as the whole value; an unset variable stays literal, which bun sends as is and autd treats as no credential
  - yarn v1 (`src/managers/yarn/npmrc.ts`): `npm_config_*` env (lower-cased, `_` as `-`, a key with `.` skipped, so no env credentials; values not expanded), the cwd's `.npmrc` (a workspace member's own), the user file (`npm_config_userconfig` against cwd, else `~/.npmrc`), `${PREFIX or the node prefix}/etc/npmrc`, then each parent's `.npmrc` nearest first, not the filesystem root; per key, credentials included. `${VAR}` expands in files; yarn fails on an unset one, autd keeps the literal and sends no credential holding it. Homebrew's yarn wrapper forces `PREFIX=/opt/homebrew`, so autd reads a different prefix file than Homebrew yarn unless it runs with the same `PREFIX`
  - yarn berry keeps npm's
  - `registryConfigFrom()` turns the result into a `RegistryConfig`: registry and `@scope:registry`, credentials per `//host/path/:` prefix (`_authToken`, `_auth`, `username` + `_password`, `certfile` + `keyfile`), `ca` / `cafile`, `strict-ssl`, proxy (`https-proxy`, `proxy`, `noproxy`, environment fallback), `fetch-retries`, `fetch-timeout`, `maxsockets`
- `src/utils/registry.ts` `createRegistrySession(cwd)` holds the run's `.npmrc` view (`registryConfig()`) and its one `node:https` client (`client()`), both loaded on first use, plus `releaseTimes(name)` for cooldown, cached per run and failing open with a debug line. `close()` destroys the client's agents. The client loads with `await import('./registryClient')` on first use, so `--version` and `help` never load it (`__tests__/startup.test.ts` guards this)
- `session.lookup(name)` loads `src/utils/registryReader.ts` lazily and returns a `PackageLookup`: `ok` with `{ name, latest, versions, source }` (each version has `deprecated`, and `publishedAt` when the source has it), or a failure with a kind and reason, never "no versions" for a network failure. Public npm names use `/-/package/<name>/dist-tags` plus deps.dev, falling back to the abbreviated packument; any other registry takes one GET with the abbreviated `Accept` (and a retry for the full document on a 404). The packument wins when it lacks the dist-tags' `latest`. A limiter per request host (`src/utils/limiter.ts`) caps in-flight requests at `maxsockets` each. deps.dev turns off for the run after a 429, a timeout, or three other 5xx or transport failures; a single such failure falls back for that package only. Discovery (`src/discovery.ts`) is its consumer
- `src/utils/registryRequest.ts` is the pure part of the client (registry per scope, packument URL, longest-prefix credential lookup, Authorization header, retry rules); `src/utils/registryClient.ts` is the `node:https` transport (keep-alive agent per registry, gzip, timeout, retries with `Retry-After`, redirects that recompute credentials). SOCKS proxies are not supported. pnpm builds its whole view as `.npmrc` layers (`npmrcLayers`, above): its yaml routes (`registry`, `registries` as a block or flat one-line flow) are layers too, the project's from the nearest ancestor with a `pnpm-workspace.yaml` when run from a member. yarn v1 and bun add their own registry files through the adapter's `registryConfig?` hook (`openProject` calls it on the session's first use): yarn v1's `.yarnrc` (`registry`, `--registry`, `--upgrade.registry`, `"@scope:registry"`; the project directory and its parents plus `~/.yarnrc`; routes only, over the view of yarn's own `.npmrc` layers; berry's `.yarnrc.yml` is not read), and bun's `bunfig.toml` (the workspace root's from a member; `[install] registry`, `[install.scopes]` and `[install.scopes.<name>]` subtables, inline `token` / `username` + `password` / URL userinfo, `$NAME` in tokens; the global `$XDG_CONFIG_HOME/.bunfig.toml` or `~/.bunfig.toml`, then the project's) and its `BUN_CONFIG_*` / `NPM_CONFIG_*` registry and token variables over `.npmrc`. Not read: bunfig dotted keys and `scopes = { … }`, a nested flow `registries` in pnpm's yaml, pnpm's Windows `%VAR%` expansion in its config directory, and yarn berry's `.yarnrc.yml` (the yarn v1 gaps are in `src/utils/CLAUDE.md`)

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
- Discovery reads every manifest (root and members) itself, so it needs no workspace flags and no subprocess. The flags (`-r` for pnpm, `--filter *` for bun) belong to apply's update commands only
- Apply writes the manifest that owns each beyond-range row (`updatePackageJson` per manifest; a `catalog:` spec writes the catalog instead). npm, pnpm and bun run one workspace-wide update command; yarn v1 runs `workspace <name> upgrade` per member, then `install`; yarn berry (2+, same adapter, `src/managers/yarn/berry.ts`) has no `outdated` and, until #107, still discovers through the manager (`ownDiscovery`): from `yarn info -A --json` plus `yarn npm info`, writes beyond-range specs itself, then `install` and `up -R <in-range names>`

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

- Node.js: `^22.23.0 || >=24.17.0`. The registry client needs `Agent` `proxyEnv` (Node 22.21, 24.5), and CVE-2026-48615 is fixed in 22.23.0 and 24.17.0. `.tool-versions` pins 24.22.1
- pnpm: >=10.0.0

## Documentation System

This project uses a 3-tier AI-optimized context system:
- **Tier 1 (Foundational)**: This file (`CLAUDE.md`) - project overview and dev commands
- **Tier 2 (Component-Level)**: `CLAUDE.md` files co-located in `src/` component directories; Claude Code loads each one when it reads files in that directory
- **Tier 3 (Feature-Specific)**: `CLAUDE.md` files in feature subdirectories (added as needed)

Documentation registry, loaded with this file:
@.claude/context/ai-context/docs-overview.md

## Testing Notes

- Test framework: Jest with `@swc/jest` as the transform
- Tests located in `__tests__/` directory (mirrors `src/` structure)
- Global setup: `__tests__/setup.ts` (suppresses console output unless `DEBUG` env is set)
- Test timeout: 15 seconds
- Uses ESM transform for TypeScript
- Mock cleanup: `clearMocks` and `restoreMocks` enabled
- Path aliases: `moduleNameMapper` maps `@/*` to `src/*` for test imports
- Manager fixtures under `__tests__/fixtures/<pm>/` are real captures of apply commands and errors (`update`, `upgrade`, yarn berry's `info`), read with `readFixture` and `exitError` from `__tests__/fixtures/index.ts`. Discovery tests use registry captures instead: `capturedRegistry(names, { asOf })` for `lookup`, `installPackages` for `node_modules`, with `asOf` the date an expectation was captured so no version drifts. Capture new fixtures from a real run, with local paths scrubbed; never hand-write manager output or registry data
- Single test: `pnpm test -- __tests__/path/to/test.test.ts`
- `testRepos/<manager>-<layout>/` are the integration matrix's fixtures (see `testRepos/README.md`): small manifests on frozen release lines, no lockfiles. The harness (`__tests__/integration/`) installs each range at its minimum, restores the ranges, rewrites the lockfile to agree (`lockfiles.ts`), then asserts autd's `check --json`, `update --dry-run --json` and `update --json` against values derived in `expectations.ts`. Manager quirks the matrix observes are per-manager overrides there, each with a comment
- CI runs the unit suite on ubuntu and windows, on the `.tool-versions` Node and on 22.23.x, then smoke-tests the built CLI (`--version`, `help`); Biome and the type check run only on ubuntu with the `.tool-versions` Node. Registry reader and parser tests serve bodies captured with curl from `__tests__/fixtures/registry/` (its README lists each capture and the checks run); variants come from `derive`, never by hand. Registry client tests run against local HTTP(S) servers and a CONNECT proxy (`__tests__/fixtures/registry.ts`) with committed test-only TLS material in `__tests__/fixtures/tls/` (`generate.sh` regenerates it) `.gitattributes` keeps every file LF so Windows checkouts match. Tests that spawn a fake manager use `writeNodeShim` and `prependPath` from `__tests__/fixtures` (a `sh` wrapper on POSIX, a cmd-shim `.cmd` on Windows); symlinks in tests use type `'junction'`, which Windows allows without privileges
