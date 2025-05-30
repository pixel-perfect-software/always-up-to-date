# Commands Reference

## Overview

| Command    | Description                           | Example                                  |
| ---------- | ------------------------------------- | ---------------------------------------- |
| `check`    | Check for outdated dependencies       | `npx alwaysuptodate check --preview`     |
| `audit`    | Scan for security vulnerabilities     | `npx alwaysuptodate audit`               |
| `auto`     | Auto-update with optional PR creation | `npx alwaysuptodate auto --createIssue`  |
| `diff`     | Show detailed version differences     | `npx alwaysuptodate diff --format table` |
| `rollback` | Undo recent changes                   | `npx alwaysuptodate rollback`            |
| `migrate`  | Apply migration rules to packages     | `npx alwaysuptodate migrate`             |

## Global Options

These options work with all commands:

- `-p, --projectPath <path>` - Specify project directory
- `-v, --verbose` - Show detailed output
- `--dry-run` - Preview changes without applying
- `--help` - Show command help

## `check` Command

Check for outdated dependencies and optionally update them.

### Usage

```bash
npx alwaysuptodate check [options]
```

### Options

- `--preview` - Show detailed report without making changes
- `--interactive` - Select specific packages to update
- `--include-dev` - Include devDependencies (default: true)
- `--only-direct` - Only check direct dependencies
- `--format <format>` - Output format: `table`, `json`, or `detailed`

### Examples

```bash
# Basic check
npx alwaysuptodate check

# Preview mode with table output
npx alwaysuptodate check --preview --format table

# Interactive selection
npx alwaysuptodate check --interactive

# Only production dependencies
npx alwaysuptodate check --include-dev false
```

## `audit` Command

Scan for security vulnerabilities in dependencies.

### Usage

```bash
npx alwaysuptodate audit [options]
```

### Options

- `--fix` - Automatically fix vulnerabilities where possible
- `--severity <level>` - Minimum severity level: `info`, `low`, `moderate`, `high`, `critical`

### Examples

```bash
# Basic audit
npx alwaysuptodate audit

# Fix vulnerabilities automatically
npx alwaysuptodate audit --fix

# Only show high and critical issues
npx alwaysuptodate audit --severity high
```

## `auto` Command

Automatically update dependencies with optional GitHub integration.

### Usage

```bash
npx alwaysuptodate auto [options]
```

### Options

- `-c, --createIssue` - Create GitHub PR with updates
- `-t, --token <token>` - GitHub token (auto-detected if not provided)
- `-r, --repository <owner/repo>` - GitHub repository (auto-detected if not provided)
- `--batch-size <size>` - Number of packages to update per batch (default: 10)
- `--separate-prs` - Create separate PRs for each major update
- `--target-branch <branch>` - Target branch for PRs (default: main)

### Examples

```bash
# Simple auto-update
npx alwaysuptodate auto

# Create GitHub PR
npx alwaysuptodate auto --createIssue

# Small batches with separate PRs for major updates
npx alwaysuptodate auto --createIssue --batch-size 3 --separate-prs

# Preview what would be updated
npx alwaysuptodate auto --dry-run
```

## `diff` Command

Show detailed differences between current and available versions.

### Usage

```bash
npx alwaysuptodate diff [options]
```

### Options

- `--format <format>` - Output format: `table`, `json`, or `detailed` (default: detailed)
- `--package <name>` - Show diff for specific package only

### Examples

```bash
# Detailed diff for all packages
npx alwaysuptodate diff

# Table format
npx alwaysuptodate diff --format table

# JSON output for scripting
npx alwaysuptodate diff --format json

# Diff for specific package
npx alwaysuptodate diff --package react
```

## `rollback` Command

Undo recent changes by restoring from backup.

### Usage

```bash
npx alwaysuptodate rollback [options]
```

### Options

- `--keep-backup` - Keep backup file after rollback
- `--backup-file <path>` - Specify custom backup file location

### Examples

```bash
# Basic rollback
npx alwaysuptodate rollback

# Keep backup file after rollback
npx alwaysuptodate rollback --keep-backup

# Rollback from specific backup
npx alwaysuptodate rollback --backup-file ./my-backup.json
```

## `migrate` Command

Apply migration rules and recommendations for specific packages.

### Usage

```bash
npx alwaysuptodate migrate [options]
```

### Options

- `--package <name>` - Apply migration for specific package
- `--from <version>` - Source version for migration
- `--to <version>` - Target version for migration
- `--preview` - Show migration instructions without applying

### Examples

```bash
# Show all available migrations
npx alwaysuptodate migrate --preview

# Migrate specific package
npx alwaysuptodate migrate --package react --from 17.0.0 --to 18.0.0

# Preview React 17 to 18 migration
npx alwaysuptodate migrate --package react --preview
```

## Exit Codes

- `0` - Success
- `1` - General error
- `2` - Updates available (when using `--exit-code` flag)
- `3` - Vulnerabilities found
- `4` - Authentication error
