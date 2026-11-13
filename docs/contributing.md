# Contributing

Always Up To Date (`autd`) is a TypeScript CLI that keeps a project's dependencies up to date under npm, yarn (v1 and berry), pnpm and bun. This guide covers setting up, the scripts, how a change is shaped and reviewed, and how to add a package manager.

## Setup

Prerequisites:

- Node.js `^22.23.0 || >=24.17.0` (`.tool-versions` pins 24.22.1)
- pnpm 12 or later (`.tool-versions` pins 12.18.0). This repository uses pnpm for everything: never npx, npm or yarn in its commands, scripts or docs
- Git

```bash
git clone https://github.com/pixel-perfect-software/always-up-to-date.git
cd always-up-to-date
pnpm install
pnpm test
pnpm run build
```

After building, run the CLI from the checkout with `pnpm run autd <command>` (for example `pnpm run autd check`).

## Scripts

| Script                      | What it does                                                                                                                                                                                                                                                                                                   |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm run build`            | Bundles `src/index.ts` with esbuild into `dist/index.cjs`, then checks startup imports and externals; a failed check removes `dist/`                                                                                                                                                                           |
| `pnpm run check-types`      | `tsc --noEmit` over `src`, `__tests__` and `bench`, then over `scripts/`. The build does not type-check                                                                                                                                                                                                        |
| `pnpm test`                 | The unit suite (Jest with `@swc/jest`). One file: `pnpm test -- __tests__/path/to/test.test.ts`                                                                                                                                                                                                                |
| `pnpm run test:coverage`    | The unit suite with coverage; `pnpm run test:badges` regenerates the badges in `./badges`, which are committed                                                                                                                                                                                                 |
| `pnpm run test:integration` | Builds, then runs the CLI against real npm, pnpm, yarn v1, yarn berry and bun on temp copies of `testRepos/`. Needs network access and the managers on `PATH` (yarn through Corepack: `corepack enable yarn`). `AUTD_INTEGRATION_PM=npm,bun` selects managers, `AUTD_INTEGRATION_KEEP=1` keeps the temp copies |
| `pnpm run bench`            | Times `check` and startup with hyperfine 2 on a 40-dependency project per manager (macOS and Linux)                                                                                                                                                                                                            |
| `pnpm run bench:gate`       | The pass/fail perf gate CI runs, one target per `AUTD_BENCH_GATE_TARGET`                                                                                                                                                                                                                                       |
| `pnpm run format-and-lint`  | Biome: formatting and lint, Markdown included. `pnpm run format-and-lint:fix` fixes what it can                                                                                                                                                                                                                |
| `pnpm run clean`            | Removes `dist/`                                                                                                                                                                                                                                                                                                |

Before opening a pull request, run `pnpm run format-and-lint`, `pnpm run check-types` and `pnpm test`. CI also runs the unit suite on Windows and on Node 22.23, the integration matrix per manager on Linux and Windows, and the perf gate.

## How the code is laid out

```
src/
  index.ts, cli.ts        # Entry and the Commander program (autd)
  commands/               # Command definitions; actions/ holds the bodies, loaded with await import()
  project.ts              # openProject(): locate the project, load the config, detect the manager
  pipeline.ts             # detect → discover → plan → apply → report, the same for every manager
  discovery.ts            # Outdated packages from the manifests, installed versions and the registries
  managers/               # One adapter per manager: npm/, pnpm/, yarn/ (v1 and berry), bun/
  utils/                  # Config, policy, the plan's passes (plan/), registry client and cache, writers, logger
schema/                   # config.schema.json and output.schema.json (every --json document)
scripts/                  # The build and its guards
bench/                    # The benchmark and the perf gate
testRepos/                # Integration fixtures, one per manager and layout
__tests__/                # Jest tests, mirroring src/
```

The full tree, with a note for each test file, is in `.claude/context/ai-context/project-structure.md`.

## Making a change

- **One issue, one branch, one pull request.** Name the branch `fix/<issue>-<slug>`, `feat/<issue>-<slug>`, `refactor/<issue>-<slug>` or `docs/<issue>-<slug>`, the slug three to five words from the issue title (`fix/35-preserve-exact-pins`).
- **Work in a git worktree** so parallel work never shares a working tree: `git worktree add .claude/worktrees/<name> -b <branch> main`. The `.claude/worktrees/` folder is where this project's sessions keep theirs.
- **Startup stays lazy.** A command's definition imports only commander, `./options`, `@/managers/names` and types, and loads its action with `await import()`. If `__tests__/startup.test.ts` or the build's startup check fails, move the import into the action; don't widen the allowed lists.
- **Failures propagate.** A failed step throws a `StepError`; never catch it and return an empty result.
- **Honor the managers.** autd never proposes what a manager's own security settings refuse (release-age gates, overrides), supports each manager's current version only, and verifies a manager's behavior with a real run, recording the version and date.
- **Fixtures are real captures.** Manager output and registry data in tests come from real runs (local paths scrubbed) or from curl; vary them with `derive`, never by hand. Don't update `__tests__/singlePackageJson.test.ts`'s snapshot to make a change pass.
- **Human output goes through `logger`**, never `console.log`: with `--json`, stdout must be exactly one JSON document.

## Commits

- **Subject:** imperative mood, sentence case, no trailing period and no conventional-commit type. It says what changes, as an outcome: "Keep exact pins exact when rewriting manifest versions".
- **Body**, for anything that isn't routine, in prose wrapped at 72 columns: what was wrong and why (the mechanism, with the exact error or value), what the code does now, and what verified it when that isn't a test in the diff. A commit with several parts gives each its own paragraph, led by its name.
- End with a blank line, then `Closes #N` or `Refs #N`. Only write a closing keyword where you mean it: GitHub closes the issue from anywhere in a pull request body.

## Pull requests

Describe the problem, what changed, the regression tests, the docs touched, the gates you ran, and a real run against the affected managers where behavior changed. Say what isn't verified. Old behavior goes in the past tense, new in the present.

## Adding a package manager

An adapter is a plain object implementing `ManagerAdapter` (`src/managers/adapter.ts`), holding only what is specific to that manager: `name` and `lockfile` (detection), `projectRoot`, `readWorkspace`, `apply`, `saveStyle`, `pinning` and `overrides`, plus optional hooks such as `npmrcLayers`, `registryConfig`, `releaseAgeGate`, `installedFromLockfile` and `installed`. Discovery is not the adapter's concern: `src/discovery.ts` reads the manifests, the installed versions and the registries for every manager, so no adapter parses a manager's `outdated`.

1. Add the name to `supportedManagers` in `src/managers/names.ts` (the `--pm` choices).
2. Write the adapter in `src/managers/<pm>/index.ts` and add it to `adapters` in `src/managers/index.ts`; `SupportedPackageManager` is derived from the names, so the registry fails to compile until the adapter is there.
3. Read the manager's registry settings and release-age gate where its current version keeps them, verified by real runs.
4. Capture real fixtures of its apply commands in `__tests__/fixtures/<pm>/`, add its layouts to `testRepos/` and its row to the integration matrix.
5. Write `src/managers/<pm>/CLAUDE.md` with what you verified, and list it in `.claude/context/ai-context/docs-overview.md`.

`src/managers/CLAUDE.md` describes every hook.

## Context docs

The repository keeps `CLAUDE.md` files for AI-assisted work, read by Claude Code and useful to anyone: the root `CLAUDE.md` (commands, invariants, module map), one per component (`src/commands/`, `src/managers/`, `src/utils/`, `bench/`, `__tests__/`), one per manager and for the plan, and reference files linked from them. `.claude/context/ai-context/docs-overview.md` lists them all with their size caps. When a change makes a statement in one of them untrue, fix it in the same pull request, and move detail down a tier rather than deleting a verified fact.

## Releases

Maintainers release with a `Release <version>` pull request that bumps `package.json` and adds the `CHANGELOG.md` entry. A `v<version>` tag on `main` then runs `.github/workflows/release.yml`, which checks the tag, runs the gates and publishes with `pnpm publish` through npm trusted publishing. Never publish from a local checkout.
