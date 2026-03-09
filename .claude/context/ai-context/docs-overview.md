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
  types.ts                  # Core types: SupportedPackageManager, PackageInfo, AlwaysUpToDateConfig
  commandRunner.ts          # Base class with runCommand() using execAsync
  detectPackageManager.ts   # Lock file detection logic
  commands/                 # CLI command definitions
    CONTEXT.md
  managers/                 # Package manager implementations
    CONTEXT.md
  utils/                    # Shared utilities
    CONTEXT.md
  migrator/                 # Framework migration (stub)
    CONTEXT.md
  prGenerator/              # PR automation (stub)
    CONTEXT.md
__tests__/
  setup.ts                  # Global test setup (console suppression)
  commandRunner.test.ts     # CommandRunner error handling tests
  detectPackageManager.test.ts  # Lock file detection tests
  managers/
    packageManager.test.ts  # Factory pattern tests
  utils/
    config.test.ts          # Config loading/saving tests
    files.test.ts           # File operations and version parsing tests
    logger.test.ts          # Logger output and quiet mode tests
    packageGrouper.test.ts  # Package grouping tests
    updateChecker.test.ts   # Semver update logic tests
```

## Tech Stack

- **Language:** TypeScript (ES2020 target, CommonJS output)
- **CLI Framework:** Commander.js
- **Package Manager:** pnpm (>=10.22.0)
- **Node:** >=22.1.0
- **Testing:** Jest + ts-jest
- **Linting/Formatting:** Biome
- **Path Aliases:** `@/*` -> `src/*` (resolved by tsc-alias at build)
- **Key Dependencies:** semver, colorette, @inquirer/prompts
