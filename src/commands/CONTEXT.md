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
  init.ts     # Creates .always-up-to-date.json with DEFAULT_CONFIG
  check.ts    # Detects package manager, lists outdated deps (grouped by scope)
  update.ts   # Detects package manager, updates packages per config rules
  help.ts     # Displays usage information
```

## Architectural Patterns

### Command Flow (check/update)
1. Detect package manager via `detectPackageManager(cwd)`
2. Create `PackageManager` factory instance
3. Call `manager.checkPackageVersions(cwd)` or `manager.updatePackages(cwd)`

### Command Options

#### `check`
- `--json` - Output raw JSON instead of formatted display (suppresses logger)

#### `update [packages...]`
- Accepts optional variadic package names to target specific packages
- `--dry-run` - Preview which packages would be updated without making changes
- `-i, --interactive` - Select packages to update from an interactive checklist (uses `@inquirer/prompts`)
- `--json` - Output `UpdateResult[]` as JSON after updating

### Binary Aliases
Published as three aliases in `package.json` `bin` field: `autd`, `alwaysuptodate`, `always-up-to-date`. All point to `dist/index.js`.

## Integration Points
- `src/detectPackageManager.ts` for package manager detection
- `src/managers/packageManager.ts` factory for manager instantiation
- `src/utils/config.ts` for loading/saving configuration
- `src/utils/filterPackages.ts` for dry-run and interactive filtering
