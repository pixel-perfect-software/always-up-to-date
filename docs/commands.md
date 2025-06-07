# Commands Reference

## Overview

| Command   | Description                     | Example                      |
| --------- | ------------------------------- | ---------------------------- |
| `check`   | Check for outdated dependencies | `npx alwaysuptodate check`   |
| `update`  | Update outdated dependencies    | `npx alwaysuptodate update`  |
| `migrate` | Migrate packages (coming soon)  | `npx alwaysuptodate migrate` |
| `help`    | Show help information           | `npx alwaysuptodate help`    |

## `check` Command

Check for outdated dependencies in your project. Automatically detects your package manager and workspace configuration.

### Usage

```bash
npx alwaysuptodate check
```

### What it does

- Detects your package manager (npm, yarn, pnpm, bun) from lock files
- Checks for workspace configuration
- Runs the appropriate outdated command for your package manager
- Displays results in a clean, readable format

### Examples

```bash
# Check for outdated dependencies
npx alwaysuptodate check

# Works in any project with npm, yarn, pnpm, or bun
cd my-npm-project && npx alwaysuptodate check
cd my-yarn-workspace && npx alwaysuptodate check
cd my-pnpm-monorepo && npx alwaysuptodate check
```

## `update` Command

Update all outdated dependencies in your project, respecting workspace configurations.

### Usage

```bash
npx alwaysuptodate update
```

### What it does

- First checks for outdated dependencies
- Filters packages that are safe to update
- Updates packages using the appropriate package manager commands
- Respects workspace configurations for monorepos

### Examples

```bash
# Update all outdated dependencies
npx alwaysuptodate update

# Works with all package managers and workspace configurations
cd my-npm-workspace && npx alwaysuptodate update
cd my-pnpm-monorepo && npx alwaysuptodate update
```

## `migrate` Command

Apply migration rules for packages with breaking changes.

### Usage

```bash
npx alwaysuptodate migrate
```

### Status

🚧 **Coming Soon** - This command is currently in development and will provide:

- Smart migration rules for popular packages (React, Next.js, etc.)
- Automated code transformations
- Detailed migration instructions
- Safe rollback capabilities

## `help` Command

Display help information and available commands.

### Usage

```bash
npx alwaysuptodate help
npx alwaysuptodate --help
npx alwaysuptodate -h
```

## Package Manager Support

The tool automatically detects your package manager:

### Detection Logic

- **npm** - Looks for `package-lock.json`
- **yarn** - Looks for `yarn.lock`
- **pnpm** - Looks for `pnpm-lock.yaml`
- **bun** - Looks for `bun.lock`

### Workspace Support

- **npm workspaces** - Detected from `package.json` workspaces field
- **yarn workspaces** - Support for yarn workspace configurations
- **pnpm workspaces** - Support for pnpm workspace configurations
- **bun workspaces** - Support for bun workspace configurations

## Exit Codes

- `0` - Success
- `1` - Error occurred during execution
