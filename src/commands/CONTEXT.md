# CLI Commands - Component Context

## Purpose
Commander.js command definitions for the CLI. Each command is a function that registers itself on the Commander program instance.

## Current Status: Stable
Four commands implemented: `init`, `check`, `update`, `help`.

## Component-Specific Development Guidelines
- Each command exports a function that accepts a `Command` (from Commander.js) and registers a subcommand
- Commands are registered in `src/cli.ts` which creates the program and calls `parseAsync()`
- Entry point chain: `src/index.ts` (shebang) -> `src/cli.ts` (program setup) -> individual commands

## Major Subsystem Organization
```
commands/
  index.ts    # Re-exports check, help, init, update
  init.ts     # Creates .always-up-to-date.json with INITIAL_CONFIG (beyondRange, rules, cooldown, debug, silent)
  check.ts    # Detects package manager, lists outdated deps (grouped by scope)
  update.ts   # Detects package manager, updates packages per config rules
  reportFailure.ts  # Reports a failed command once (human or JSON) and sets exit code 1
  help.ts     # Displays usage information
```

## Architectural Patterns

### Command Flow (check/update)
1. Detect package manager via `detectPackageManager(cwd)`
2. Get its adapter with `adapterFor(name)` (`src/managers`)
3. Run the pipeline (`src/pipeline.ts`): `check(adapter, cwd)`, or `update(adapter, cwd, { targetPackages })`. Dry-run is `check` then `plan`

### Command Options

#### `check`
- `--json` - Output raw JSON instead of formatted display

#### `update [packages...]`
- Accepts optional variadic package names to target specific packages
- `--dry-run` - Preview which packages would be updated without making changes: each row shows `current → target`, flagged `beyond range` when it leaves its manifest range; held rows show the policy's reason
- `-i, --interactive` - Select packages to update from an interactive checklist (uses `@inquirer/prompts`). Discovery runs once: the checklist's `check` result is passed to `update(adapter, cwd, { targetPackages: selected, discovered })`
- `--json` - Output `UpdateResult[]` as JSON (`[]` when nothing is outdated, including with `--dry-run`). Conflicts with `--interactive`

### JSON output
With `--json`, stdout carries exactly one JSON document. The action calls `logger.setJsonOutput(true)` before anything else: progress output is dropped, and errors, warnings and debug lines go to stderr. All human-facing output must go through `logger`; a bare `console.log` anywhere on the command path breaks `--json`.

### Failures
`check` and `update` wrap their whole action and hand any error to `reportFailure()` (`reportFailure.ts`), which sets `process.exitCode = 1` and reports once:
- human mode: `Failed during <step>: <message>`, plus a warning when `package.json` was already rewritten
- `--json`: `{ "error": { "step", "message", "manifestWritten" } }` on stdout, never `[]`

`step` comes from a `StepError` (`src/stepError.ts`): `detect` (no lockfile), `discover` (`outdated` failed), `apply` (the manager's update/install failed). Managers must let these propagate; catching and returning `[]` turns a failure into "nothing to update" with exit 0.

### Binary Aliases
Published as three aliases in `package.json` `bin` field: `autd`, `alwaysuptodate`, `always-up-to-date`. All point to `dist/index.js`.

## Integration Points
- `src/detectPackageManager.ts` for package manager detection
- `src/managers` `adapterFor(name)` for the detected manager's adapter
- `src/pipeline.ts` `check`, `plan` and `update`
- `src/utils/config.ts` for loading/saving configuration
