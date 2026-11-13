# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Always Up To Date (`autd`) is a CLI that keeps a project's dependencies up to date: it detects the package manager (npm, yarn v1 and berry, pnpm, bun), discovers outdated dependencies natively from the manifests, the installed versions and the registries, plans each move under the project's policy and every manager's security settings, then applies it through the manager. Workspaces, catalogs and member runs are supported.

## Development Commands

- `pnpm run build` - Bundle `src/index.ts` with esbuild into `dist/index.cjs` and run the startup and externals checks (detail in `.claude/context/ai-context/project-structure.md`). tsc emits nothing, so the build does not type-check
- `pnpm run check-types` - `tsc --noEmit` over `src`, `__tests__` and `bench`, then `tsc -p scripts`
- `pnpm run clean` - Remove `dist/`
- `pnpm test` - The unit suite (silent). One file: `pnpm test -- __tests__/path/to/test.test.ts`
- `pnpm run test:coverage` - The unit suite with coverage; `pnpm run test:badges` regenerates `./badges` (commit them)
- `pnpm run test:integration` - The integration matrix: the built CLI against real npm, pnpm, yarn v1, berry and bun (`__tests__/CLAUDE.md`)
- `pnpm run bench` / `pnpm run bench:gate` - The benchmark and the perf gate CI's `perf` job runs (`bench/CLAUDE.md`)
- `pnpm run format-and-lint` / `pnpm run format-and-lint:fix` - Check or fix formatting and linting with Biome (Markdown included)
- `pnpm run autd <command>` - Run the built CLI (`node dist/index.cjs <command>`) in the current directory, e.g. `pnpm run autd init`, `pnpm run autd check`; build first
- Releasing: `/ship:release <major|minor|patch>`, then a `v<version>` tag on `main` runs `.github/workflows/release.yml`. Publish only through `release.yml`, never from a local checkout, and never rename it (it is npm's trusted publisher). Detail in `project-structure.md`

## Invariants

- **pnpm only**, in commands, scripts and docs: never npx, npm or yarn for this repo (`engines.pnpm` is `>=12.0.0`; Node `^22.23.0 || >=24.17.0`, `.tool-versions` pins 24.22.1)
- **Failures propagate as a `StepError`** (`src/stepError.ts`, step `detect` / `discover` / `apply`) to the command, which reports once and exits 1 (`reportFailure`). Never catch and return an empty result: that turns an outage into "nothing to update" with exit 0. A failed registry lookup fails the run; the reader reports failures per package and never answers "no versions" for a network failure
- **Manager commands are argument arrays** through `runCommand` / `runProcess` (`execFile`, no shell, no output cap), judged by exit code and parsable stdout, never by stderr
- **Startup is lazy** (#109): `autd --version` initializes only commander, the command definitions and `src/managers/names.ts`. A command's definition imports only commander, `./options`, `@/managers/names` and types, and loads its action with `await import()`; actions import leaf modules (`src/utils` has no barrel). `__tests__/startup.test.ts` and the build's startup check (`STARTUP_SOURCES` / `STARTUP_PACKAGES`, `scripts/guards.ts`) fail when something heavy reaches startup: move the import into the action, never widen the lists (a new command's definition file is the one addition). Detail in `src/commands/CLAUDE.md`
- **Honor every manager security default**: autd never overrides a manager's security setting. A manager's release-age gate (pnpm `minimumReleaseAge`, berry `npmMinimalAgeGate`, bun `minimumReleaseAge`, npm `min-release-age`; #166, #168) applies to every lookup, so autd never proposes a version the manager refuses for its age; overrides the manager enforces are held too. A new gate or setting is mirrored in the same change
- **Current manager versions only**, verified by real runs: support the current version of each manager, and verify its behavior with a real run (record the version, date and probe IDs) rather than reading fields older versions honored
- **Real captures only**: manager output and registry data in tests are captured from real runs (local paths scrubbed) and varied with `derive`, never hand-written (`__tests__/CLAUDE.md`)
- **Never update `singlePackageJson.test.ts`'s snapshot to make a change pass**: it was reviewed once for #106 and regenerated once for #201
- **Output**: human output goes through `logger`, never `console.log`. With `--json`, stdout is exactly one versioned document (#201, `schema/output.schema.json`); errors, warnings and debug lines go to stderr in every mode (#223)
- **The config is loaded once per run**, by `openProject`, and passed down as `project.config`; `--help`, `--version` and `init` never read it. Validation is strict (#217): a typo must not turn a gate off
- Path aliases: `@/*` maps to `src/*` (`import logger from "@/utils/logger"`, always a leaf module)

## Module map

Each line names where the detail lives. `pipeline.md` is `.claude/context/ai-context/pipeline.md`.

- `src/index.ts` → `src/cli.ts`: entry and the Commander program (`autd`; aliases `alwaysuptodate`, `always-up-to-date`)
- `src/commands/`: definitions `init`, `check`, `update`, the actions they load, `reportFailure` (`src/commands/CLAUDE.md`)
- `src/project.ts`, `src/projectLocation.ts`: `openProject` builds the `Project` (`{ root, member?, config, adapter, registry }`) once per run: locate, config, logger, detection, the manager's root (`pipeline.md`)
- `src/detectPackageManager.ts`: `--pm`, then `packageManager`, then `devEngines.packageManager`, then the lockfiles (`pipeline.md`)
- `src/pipeline.ts`: detect → discover → plan → apply → report for every adapter; `check`, `findOutdated`, `plan`, `update`, `refuseMemberApply` (`pipeline.md`)
- `src/discovery.ts`: native discovery for every manager, no subprocess (`pipeline.md`)
- `src/commandRunner.ts`, `src/stepError.ts`: manager commands and step failures (`pipeline.md`)
- `src/types.ts`: `PackageInfo`, `UpdateResult`, `Reason`, `AlwaysUpToDateConfig`, `RegistryConfig`
- `src/managers/`: one adapter per manager, the workspace member map, cooldown pins, the beyond-range writer (`src/managers/CLAUDE.md`, then `npm/`, `pnpm/`, `yarn/`, `bun/` `CLAUDE.md`)
- `src/utils/`: config, policy, logger, installed versions, specs (`src/utils/CLAUDE.md`); registry, `.npmrc` and cache (`src/utils/REGISTRY.md`); the plan's passes (`src/utils/plan/CLAUDE.md`); writers (`src/utils/MANIFESTS.md`); report and rows (`src/utils/OUTPUT.md`)
- `schema/`: `config.schema.json` (referenced by the `$schema` `init` writes) and `output.schema.json` (every `--json` document)
- `scripts/`: the build and its guards (`project-structure.md`)
- `bench/`, `__tests__/`, `testRepos/`: `bench/CLAUDE.md`, `__tests__/CLAUDE.md`

## Documentation System

This project uses a 3-tier AI-optimized context system:

- **Tier 1 (Foundational)**: this file, and the registry it imports; `project-structure.md` and the reference docs load on demand
- **Tier 2 (Component-Level)**: `CLAUDE.md` in `src/commands/`, `src/managers/`, `src/utils/`, `bench/` and `__tests__/`; Claude Code loads each one when it reads files in that directory
- **Tier 3 (Feature-Specific)**: `CLAUDE.md` in `src/managers/<pm>/` and `src/utils/plan/`

Size caps and the full list are in the registry. Move detail down a tier, or into a linked reference, rather than deleting it.

Documentation registry, loaded with this file:
@.claude/context/ai-context/docs-overview.md
