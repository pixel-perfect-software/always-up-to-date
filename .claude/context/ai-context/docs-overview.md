# Documentation Architecture

Documentation registry and index for the Always Up To Date project. This file maps all context documents across the 3-tier system.

## 3-Tier Documentation System

| Tier | Scope | Location |
|------|-------|----------|
| 1 - Foundational | Project-wide overview, dev commands, architecture summary | `/CLAUDE.md` |
| 2 - Component-Level | Component purpose, patterns, integration points | `src/{component}/CONTEXT.md` |
| 3 - Feature-Specific | Granular feature implementation details | `src/{component}/{feature}/CONTEXT.md` |

## Documentation Registry

### Tier 1 (Foundational)

| Document | Path | Description |
|----------|------|-------------|
| Project Overview | `/CLAUDE.md` | Dev commands, architecture, conventions, engine requirements |
| Documentation Index | `.claude/context/ai-context/docs-overview.md` | This file - maps all documentation |

### Tier 2 (Component-Level)

| Component | Path | Description |
|-----------|------|-------------|
| Package Managers | `src/managers/CONTEXT.md` | Manager abstraction, CommandRunner, detection, workspace support |
| CLI Commands | `src/commands/CONTEXT.md` | Commander.js setup, command registration, binary aliases |
| Utilities | `src/utils/CONTEXT.md` | Config system, update logic, logging, file ops, package grouping |
| Migrator | `src/migrator/CONTEXT.md` | Framework migration rules (stub) |
| PR Generator | `src/prGenerator/CONTEXT.md` | Automated PR creation (stub) |

### Tier 3 (Feature-Specific)

No Tier 3 documents yet. As features grow in complexity, add `CONTEXT.md` files in subdirectories (e.g., `src/managers/npm/CONTEXT.md`).

## Project Structure

```
src/
  index.ts                  # Entry point (shebang, calls cli)
  cli.ts                    # Commander.js program setup, registers commands
  types.ts                  # Core types: SupportedPackageManager, PackageInfo, UpdateResult, AlwaysUpToDateConfig, CooldownConfig, RegistryConfig
  commandRunner.ts          # runCommand(pm, args, cwd, isSuccess?) via runProcess; runStep() tags failures
  project.ts                # openProject(cwd, { pm? }): loads the config once, configures the logger, detects the manager → Project
  pipeline.ts               # check / plan / update (take a Project): detect → discover → plan → apply → report for any adapter
  detectPackageManager.ts   # --pm, then packageManager, then devEngines.packageManager, then the adapters' lockfiles
  stepError.ts              # StepError: failed pipeline step (detect/discover/apply) + manifestWritten
  commands/                 # CLI command definitions
    CONTEXT.md
  managers/                 # One adapter per package manager (adapter.ts interface, index.ts registry)
    CONTEXT.md
  utils/                    # Shared utilities
    CONTEXT.md
  migrator/                 # Framework migration (stub)
    CONTEXT.md
  prGenerator/              # PR automation (stub)
    CONTEXT.md
schema/
  config.schema.json        # JSON schema for .always-up-to-date.json (referenced via $schema)
__tests__/
  setup.ts                  # Global test setup (console suppression)
  index.test.ts             # CLI entry: a failure to start prints and exits 1
  cli.test.ts               # Loading the CLI reads no config
  project.test.ts           # openProject: config loaded once, logger configured before detection
  pipeline.test.ts          # The pipeline plans with project.config and never loads it; reports a package the manager left in place; npm workspace rows
  singlePackageJson.test.ts # Snapshot of single-package check/plan/update JSON, pinned before #59: never update it to make a change pass
  commandRunner.test.ts     # Success checks, stderr-at-debug, failure messages
  commands/
    check.test.ts, help.test.ts, init.test.ts, update.test.ts  # Command registration and options
    jsonOutput.test.ts      # Real logger: stdout is exactly one JSON document with --json
    failures.test.ts        # Failed steps and a malformed config: exit code 1, one message, JSON error object
  detectPackageManager.test.ts  # Detection order on real temp dirs: --pm, packageManager, devEngines, lockfiles; stray-lockfile logging
  fixtures/
    index.ts                # readFixture(), exitError(), projectFor(), writeWorkspaceProject(), WORKSPACE_ENTRIES helpers
    npm/ pnpm/ yarn/ bun/   # Real captured manager stdout/stderr (outdated, errors)
  managers/
    adapters.test.ts        # Registry: adapterFor(name), one lockfile per manager
    npm.test.ts, pnpm.test.ts, bun.test.ts  # outdated exit-code semantics on real output; direct parser tests on fixtures; npm current from package-lock.json with no node_modules
    yarn.test.ts            # outdated exit codes, upgrade/up descriptors, berry detection, parser
    realSubprocess.test.ts  # Fake npm on PATH: >1 MB output, names passed as arguments (POSIX)
    reuseDiscovery.test.ts  # update with a discovery result runs only the apply command
    withinRange.test.ts     # Real output, default config: proposes exactly npm update's set; zero for pins
    applyRanges.test.ts     # In-range apply writes nothing; beyond-range writes the target spec first
    aliases.test.ts         # Real alias output from all four managers: manifest key, no crash on exotic
    stepFailures.test.ts    # Each manager rejects with a discover/apply StepError
    workspaces.test.ts      # Member map (patterns, negations, skips) and workspaceOwner
    workspaceDiscovery.test.ts  # Workspace check on all four managers returns one record; unnamed roots
    workspaceApply.test.ts  # Workspace apply per manager: commands, member manifest writes, catalog routing
  utils/
    config.test.ts          # Config loading/saving tests (incl. cooldown variants)
    cooldown.test.ts        # Normalize/evaluate cooldown gate
    duration.test.ts        # parseDuration + formatAgeDays
    files.test.ts           # File operations and version parsing tests
    filterPackages.test.ts  # Package filtering, targeting, cooldown integration
    logger.test.ts          # Logger output, configure(), quiet and JSON output modes
    npmrcLoader.test.ts     # .npmrc / NPM_CONFIG_* parsing
    packageGrouper.test.ts  # Package grouping tests
    runProcess.test.ts      # Real child processes: no output cap, no shell, Windows quoting
    updateChecker.test.ts   # Update policy: within range, beyondRange levels, rules, legacy mapping
    overrides.test.ts       # Which override keys pin a package, per manager's current version
    peers.test.ts           # Installed peer ranges from hoisted node_modules and the pnpm store
    saveStyle.test.ts       # Where each manager keeps save-exact / save-prefix
    manifestNames.test.ts   # Report names mapped back to package.json keys
    workspaceRows.test.ts   # foldWorkspaceEntries ordering and top-level choice
    installed.test.ts       # Installed root-dependency versions (hoisted, scoped, alias, pnpm symlink); checkApplied
```

## Tech Stack

- **Language:** TypeScript (ES2020 target, CommonJS output)
- **CLI Framework:** Commander.js
- **Package Manager:** pnpm (>=10.0.0)
- **Node:** >=24.0.0
- **Testing:** Jest + ts-jest
- **Linting/Formatting:** Biome
- **Path Aliases:** `@/*` -> `src/*` (resolved by tsc-alias at build)
- **Key Dependencies:** semver, colorette, @inquirer/prompts, npm-registry-fetch (registry metadata for cooldown), ini (.npmrc parsing)
