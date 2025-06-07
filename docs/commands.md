# Commands Reference

## Overview

| Command   | Description                     | Example        |
| --------- | ------------------------------- | -------------- |
| `check`   | Check for outdated dependencies | `autd check`   |
| `update`  | Update outdated dependencies    | `autd update`  |
| `migrate` | Migrate packages (coming soon)  | `autd migrate` |
| `help`    | Show help information           | `autd help`    |

## `check` Command

Check for outdated dependencies in your project. Automatically detects your package manager and workspace configuration.

### Usage

```bash
autd check
```

### What it does

- Detects your package manager (npm, yarn, pnpm, bun) from lock files
- Checks for workspace configuration
- Runs the appropriate outdated command for your package manager
- Displays results in a clean, readable format

### Examples

```bash
# Check for outdated dependencies
autd check

# Works in any project with npm, yarn, pnpm, or bun
cd my-npm-project && autd check
cd my-yarn-workspace && autd check
cd my-pnpm-monorepo && autd check
```

## `update` Command

Update all outdated dependencies in your project, respecting workspace configurations.

### Usage

```bash
autd update
```

### What it does

- First checks for outdated dependencies
- Filters packages that are safe to update
- Updates packages using the appropriate package manager commands
- Respects workspace configurations for monorepos

### Examples

```bash
# Update all outdated dependencies
autd update

# Works with all package managers and workspace configurations
cd my-npm-workspace && autd update
cd my-pnpm-monorepo && autd update
```

## `migrate` Command

Apply migration rules for packages with breaking changes.

### Usage

```bash
autd migrate
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
autd help
autd --help
autd -h
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
