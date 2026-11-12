# CLI Commands - Component Context

## Purpose

Commander.js command definitions for the CLI. Each command is a function that registers itself on the Commander program instance.

## Current Status: Stable

Three commands implemented: `init`, `check`, `update`. `help [command]` is commander's own, and the program is named `autd` in `src/cli.ts` (#224).

## Component-Specific Development Guidelines

- Each command exports a function that accepts a `Command` (from Commander.js) and registers a subcommand
- Commands are registered in `src/cli.ts` which creates the program and calls `parseAsync()`
- Entry point chain: `src/index.ts` (shebang) -> `src/cli.ts` (program setup) -> individual commands
- A command is two files (#109). The definition (`<name>.ts`) declares the options and exports its options type (`CheckOptions`, `UpdateOptions`); it imports only commander, `./options`, `@/managers/names` and types. Its `.action()` does `const { checkAction } = await import('./actions/check')` and calls it. The action (`actions/<name>.ts`) holds the body and imports what it needs, its options type with `import type` from the definition (no runtime cycle)
- Why: `autd --version` then initializes only commander, the definitions and `src/managers/names.ts` (`supportedManagers`, which `--pm`'s choices use; `src/managers/index.ts` would pull in every adapter); any other command adds what its action loads (the logger). Nothing the pipeline needs loads before an action runs. `SupportedPackageManager` (`src/types.ts`) is derived from `supportedManagers`, and `adapters.test.ts` keeps it equal to `adapters`' keys in order. In a bundle the saving is all lazy loading: esbuild initializes a module on first use only when it is reached through `import()` alone, so a static import from the definition path makes it eager. Measured 2026-11-05 (Node 24.22.1, macOS arm64, `hyperfine -N`): `--version` 8 ms over bare `node -e 0`, where the tsc build was 37 ms over
- In an action: import leaf modules (`@/utils/logger`, `@/utils/config`); read `process.cwd()` inside the action function, not at module top; load `@inquirer/prompts` with `await import()` (it stays external in the bundle, so a static import fails the build)
- Two guards fail when something heavy reaches the definition path: `__tests__/startup.test.ts` (each of the pipeline, project, managers, logger, config, actions, semver, colorette and `@inquirer/prompts` is a Jest mock that records its load, and none loads with the CLI; nor do the registry client, reader or cache) and the build's startup check (`STARTUP_SOURCES` and `STARTUP_PACKAGES` in `scripts/guards.ts`, which `scripts/build.mts` runs: it walks the esbuild metafile from `src/index.ts` and `src/cli.ts` along `import` and `require` edges and throws the chain, e.g. `src/cli.ts → src/commands/options.ts → src/pipeline.ts`). The Jest guard tracks only the modules it mocks; the build's walk covers every input. Move the import into the action; do not add the module to `STARTUP_SOURCES` or `STARTUP_PACKAGES` to make it pass (a new command's definition file is the one addition to `STARTUP_SOURCES`)

## Major Subsystem Organization

```
commands/
  index.ts    # Re-exports check, init, update
  options.ts  # pmOption() (--pm, choices from supportedManagers), noCacheOption(): shared by check and update
  init.ts     # Definition of `init`: loads actions/init
  check.ts    # Definition of `check` (--json, --pm, --no-cache), CheckOptions: loads actions/check
  update.ts   # Definition of `update [packages...]` (--dry-run, -i, --json, --pm, --no-cache), UpdateOptions: loads actions/update
  reportFailure.ts  # Reports a failed command once (human or JSON) and sets exit code 1
  actions/    # The bodies, each loaded with await import() when its command runs
    init.ts   # Creates .always-up-to-date.json with INITIAL_CONFIG (beyondRange, rules, cooldown, debug, silent) in the nearest package.json's directory (else the cwd), where `loadConfig` reads it
    check.ts  # Detects package manager, prints the planned report (each outdated dep under its outcome); --json plans (`findOutdated`, `plan`) and prints the plan document
    update.ts # Detects package manager, updates packages per config rules; --dry-run, and -i (choicesByPackage, interactiveUpdate with the dynamic @inquirer/prompts import)
```

## Architectural Patterns

### Command Flow (check/update)

1. Open the project inside the `try` with `openProject(cwd, { pm: options.pm, cache: options.cache })` (`src/project.ts`): locates the workspace root (from a workspace member too, #123), loads the config (the member's own file, else the root's), configures the logger, detects the manager (or takes `--pm`) and gets its adapter. A bad config or no manager fails here and goes through `reportFailure` like any other failure
2. Run the pipeline (`src/pipeline.ts`) with that project: `check(project, { next })`, or `update(project, { targetPackages })`. `--dry-run`, `check --json` and `-i` run `findOutdated(project, targets)` then `plan(project, outdated, targetPackages)`
3. Close the run's registry session in `finally` (`project?.registry.close()`; `project` is declared before the `try`), so a failed run releases its connections too

### Command Options

#### `check` and `update`

- `--pm <npm|yarn|pnpm|bun>` - Use this manager instead of detecting one (`pmOption()` in `src/commands/options.ts`; commander rejects other values)
- `--no-cache` - Ask the registries instead of autd's cache (`noCacheOption()`; commander makes `options.cache` true unless passed, and the commands hand it to `openProject(cwd, { pm, cache })`). It, and `AUTD_NO_CACHE` set to anything but empty, `0` or `false`, reads and writes no registry cache and does not even resolve its folder; `AUTD_CACHE_DIR=<path>` (against cwd) relocates the folder

#### `check`

- `--json` - Print the plan document (`planDocument`, `command: 'check'`, `phase: 'plan'`): the rows `update --dry-run --json` prints, planned with `findOutdated` then `plan`, so it reads the moving targets' version manifests (cached). One row per package and manifest (`workspace` is `'.'` for the root and in a single package); from a member the rows cover that member's manifest and `member` holds its path

#### `update [packages...]`

- Accepts optional variadic package names to target specific packages. A named package no manifest the run reads declares fails with a `discover` `StepError` (`<name> isn't a dependency of this project`) before the header or any lookup; a named dependency discovery finds current gets an info line (`<name> is already up to date`)
- From a workspace member (#123) `update` that writes is refused: plain, by name and `-i` all call `refuseMemberApply(project)` (`src/pipeline.ts`), which throws an `apply` `StepError` (`manifestWritten: false`, `refusal: true`: `reportFailure` prints the message with no "Failed during" prefix) naming the workspace root, before any discovery, registry lookup, manager subprocess or prompt. `--json` prints the usual error object. A pnpm directory with its own `pnpm-workspace.yaml` and a directory no root lists are projects of their own and update normally
- `--dry-run` - Preview without making changes (also from a member, where it plans that member's manifest only): the report `check` prints, for the targeted packages (`findOutdated(project, targets)`, which fails on a name no manifest declares and names one that is current, then `plan`, then `logger.report(…, 'plan', { member })`, `member` being the member's path from a member run)
- `-i, --interactive` - Select packages to update from an interactive checklist (uses `@inquirer/prompts`). Refused before `openProject` (`refuseInteractive`, `actions/update.ts`) without a terminal (`process.stdin.isTTY`), with package names, or with `--dry-run`, each message naming the form to use instead. The checklist has one choice per package, listing its manifests in a workspace project; targeting stays by name. Discovery runs once: the checklist's `findOutdated` result is passed to `update(project, { targetPackages: selected, discovered })`
- `--json` - Print the plan document: `phase: 'plan'` with `--dry-run`, `'applied'` after `update` has run; the same row shape as `check` (`rows` is `[]` when nothing is outdated). Conflicts with `--interactive`

### JSON output

With `--json`, stdout carries exactly one versioned JSON document (#201): a plan document `{ version: 1, autd, command, phase, manager, member, rows }` or an error document, built by `src/utils/jsonDocument.ts` (`planDocument`, `errorDocument`, `printJson`; described by `schema/output.schema.json`) and loaded by the actions and `reportFailure` only, never by a definition. A row is `{ name, workspace, current, wanted, latest, target, updateType, outcome, reason: { code, message }, warnings, releaseAgeDays }` (`src/utils/OUTPUT.md` for how a result becomes one): `current` is null when not installed, `target` null when held, and `outcome` is `update`, `held`, `not-applied` or `not-targeted`, the same for `check`, `update --dry-run` and `update`. A consumer branches on `outcome` and `reason.code`; 4.x may add codes and fields within version 1. The published schema (draft-07) is open (objects allow additional properties, `reason.code` is a string with the known codes as `examples`; `outcome`, `version`, `command` and `phase` stay closed; #218). Tests validate every document against a strict form of it with Ajv (a test-only devDependency, `__tests__/fixtures/outputSchema.ts`: `validateOutput`, derived at load time by closing every object and making `reason.code` an enum of `REASON_CODES`, so an unlisted field or code fails the suite; `validatePublished` uses the schema as shipped). The action calls `logger.setJsonOutput(true)` before anything else: progress output is dropped, and errors, warnings and debug lines go to stderr. All human-facing output must go through `logger`; a bare `console.log` anywhere on the command path breaks `--json`.

### Failures

`check` and `update` wrap their whole action and hand any error to `reportFailure(error, { json, command })` (`reportFailure.ts`), which sets `process.exitCode = 1` and reports once:

- human mode: `Failed during <step>: <message>`, plus a warning when `package.json` was already rewritten
- `--json`: the error document `{ version: 1, autd, command, error: { step, message, manifestWritten } }` on stdout, never `rows: []`; `step` is `null` outside a step (a malformed config)

`step` comes from a `StepError` (`src/stepError.ts`): `detect` (no lockfile), `discover` (an unreadable manifest, nothing installed, a failed registry lookup), `apply` (the manager's update/install failed). Managers must let these propagate; catching and returning `[]` turns a failure into "nothing to update" with exit 0.

### Binary Aliases

Published as three aliases in `package.json` `bin` field: `autd`, `alwaysuptodate`, `always-up-to-date`. All point to `dist/index.js`.

## Integration Points

- `src/detectPackageManager.ts` for package manager detection
- `src/project.ts` `openProject(cwd, { pm })` for the config, logger setup and the detected manager's adapter
- `src/pipeline.ts` `check`, `plan` and `update`
- `src/utils/config.ts` for loading/saving configuration
