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
- `pnpm run test:badges` - Generate coverage badges in ./badges directory
- Single test: `pnpm test -- tests/path/to/test.test.ts`

### Code Quality
- `pnpm run lint` - Lint TypeScript files with ESLint
- `pnpm run format` - Format all files with Prettier

### Local Development
- `pnpm run init` - Initialize config in the current directory
- `pnpm run check-deps` - Check for outdated dependencies
- `pnpm run update-deps` - Update dependencies
- After building, the CLI can be tested locally with: `node dist/index.js <command>`

## Architecture

### Core Components

**Package Manager Abstraction**
- `src/detectPackageManager.ts` detects the package manager by checking for lock files (package-lock.json, yarn.lock, pnpm-lock.yaml, bun.lock)
- `src/managers/packageManager.ts` is a factory that instantiates the correct manager based on detection
- Each manager (npm, yarn, pnpm, bun) extends `CommandRunner` and implements:
  - `checkPackageVersions(cwd)` - Returns outdated packages as JSON
  - `updatePackages(cwd)` - Updates packages respecting configuration
  - `checkIfInWorkspace(cwd)` - Detects workspace/monorepo configuration

**Command Runner Pattern**
- `src/commandRunner.ts` provides the base `runCommand()` method that all package managers use
- Executes package manager commands via `execAsync` and handles stdout/stderr appropriately
- All manager commands go through this abstraction for consistency

**Configuration System**
- Config file: `.always-up-to-date.json` in the project root
- Loaded via `src/utils/config.ts` with the `loadConfig()` function
- Supports:
  - `allowMinorUpdates` / `allowMajorUpdates` - Control update scope
  - `updateAllowlist` / `updateDenylist` - Fine-grained package control
  - `debug` / `silent` - Logging control
- `src/utils/updateChecker.ts` validates whether a package should be updated based on config

**CLI Structure**
- Entry point: `src/index.ts` → `src/cli.ts`
- Uses Commander.js for command parsing
- Commands registered in `src/commands/`:
  - `init` - Creates `.always-up-to-date.json`
  - `check` - Lists outdated dependencies
  - `update` - Updates packages respecting config
  - `help` - Shows help information
- Binary aliases: `autd`, `alwaysuptodate`, `always-up-to-date`

**Workspace Detection**
- npm/yarn/bun: Checks `package.json` for `workspaces` field (array or object with packages)
- pnpm: Checks for `pnpm-workspace.yaml` file
- When detected, commands append workspace flags (e.g., `--workspaces` for npm)

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

- Node.js: >=22.1.0
- pnpm: >=10.22.0

## Testing Notes

- Test framework: Jest with ts-jest
- Tests located in `tests/` directory
- Test timeout: 15 seconds
- Uses ESM transform for TypeScript
- Mock cleanup: `clearMocks` and `restoreMocks` enabled
