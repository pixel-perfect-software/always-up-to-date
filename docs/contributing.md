# Contributing Guide

We welcome contributions to Always Up To Date! This guide will help you get started.

## Getting Started

### Prerequisites

- Node.js 24 or higher
- pnpm >=10.0.0 (npm, yarn, or bun also supported for consumers)
- Git

### Setup

1. **Fork the repository** on GitHub

2. **Clone your fork**:

   ```bash
   git clone https://github.com/your-username/always-up-to-date.git
   cd always-up-to-date
   ```

3. **Install dependencies**:

   ```bash
   pnpm install
   # or npm, yarn, bun
   ```

4. **Run tests**:

   ```bash
   pnpm test
   ```

5. **Build the project**:
   ```bash
   pnpm run build
   ```

## Development Workflow

### Branch Strategy

1. Create a feature branch from `main`:

   ```bash
   git checkout -b feature/your-feature-name
   ```

2. Make your changes

3. Write or update tests

4. Ensure all tests pass:

   ```bash
   pnpm test
   pnpm run lint
   ```

5. Commit with conventional commits:

   ```bash
   git commit -m "feat: add yarn workspace support"
   ```

6. Push and create a pull request

### Commit Convention

We use [Conventional Commits](https://www.conventionalcommits.org/):

- `feat:` - New features
- `fix:` - Bug fixes
- `docs:` - Documentation changes
- `test:` - Test additions or changes
- `refactor:` - Code refactoring
- `chore:` - Maintenance tasks

## Project Structure

```
src/
├── cli.ts                  # CLI entry point using Commander.js
├── index.ts               # Main entry point
├── commandRunner.ts       # Base class for running package manager commands
├── detectPackageManager.ts # Auto-detect package manager logic
├── types.ts               # TypeScript type definitions
├── commands/              # Command implementations
│   ├── index.ts          # Command exports
│   ├── check.ts          # Check for outdated dependencies
│   ├── update.ts         # Update dependencies
│   ├── migrate.ts        # Migration command (in development)
│   └── help.ts           # Help command
├── managers/              # Package manager implementations
│   ├── index.ts          # Manager exports
│   ├── packageManager.ts # Manager factory class
│   ├── npm/              # npm implementation
│   ├── yarn/             # yarn implementation (coming soon)
│   ├── pnpm/             # pnpm implementation (coming soon)
│   └── bun/              # bun implementation (coming soon)
├── migrator/              # Migration system (in development)
│   ├── index.ts
│   └── rules/            # Migration rules for packages
├── prGenerator/           # PR generation system (in development)
│   └── index.ts
└── utils/                 # Utility functions
    ├── index.ts
    ├── logger.ts          # Logging utilities
    └── updateChecker.ts   # Update filtering logic
```

## Current Implementation Status

### ✅ Implemented

- Basic CLI structure with Commander.js
- Package manager auto-detection (npm, yarn, pnpm, bun)
- npm support with workspace detection
- Basic check and update commands
- Modular architecture for extensibility

### 🚧 In Development

- yarn, pnpm, bun package manager support
- Migration system with smart rules
- PR generation system

### 📋 Planned

- Advanced configuration options
- GitHub integration
- Interactive update selection
- Rollback functionality
- Enhanced error handling and logging

## Testing

### Test Setup

Tests are located in the same directory structure as the source code but with `.test.ts` extension.

### Running Tests

```bash
# All tests
pnpm test

# Watch mode
pnpm run test:watch

# Coverage report (if configured)
pnpm run test:coverage
```

### Writing Tests

Use Jest with the existing patterns:

```typescript
import { detectPackageManager } from "../detectPackageManager"

describe("detectPackageManager", () => {
  it("should detect npm from package-lock.json", () => {
    // Test implementation
  })
})
```

## Adding New Features

### Adding Package Manager Support

1. Create a new manager in `src/managers/[package-manager]/index.ts`
2. Extend the `CommandRunner` class
3. Implement required methods:

```typescript
import CommandRunner from "@/commandRunner"

class YarnManager extends CommandRunner {
  public readonly packageManager: SupportedPackageManager = "yarn"

  checkPackageVersions = async (cwd: string): Promise<object> => {
    // Implementation
  }

  updatePackages = async (cwd: string): Promise<void> => {
    // Implementation
  }

  checkIfInWorkspace = async (cwd: string): Promise<boolean> => {
    // Implementation
  }
}
```

4. Add to `PackageManager` factory in `src/managers/packageManager.ts`
5. Update lock file detection in `src/detectPackageManager.ts`
6. Write tests for the new package manager

### Adding Migration Rules

1. Create rule files in `src/migrator/rules/[package-name]/`
2. Follow the planned migration rule structure
3. Register rules with the migrator system
4. Write tests for migration rules

### Adding New Commands

1. Create command file in `src/commands/`
2. Implement using Commander.js pattern:

```typescript
import type { Command } from "commander"

const newCommand = (program: Command) =>
  program
    .command("new-command")
    .description("Description of the new command")
    .action(async () => {
      // Command implementation
    })

export default newCommand
```

3. Export from `src/commands/index.ts`
4. Register in `src/cli.ts`
5. Write tests for the command

## Code Style

### TypeScript Guidelines

- Use strict TypeScript configuration
- Prefer interfaces over types for object shapes
- Use proper typing (avoid `any`)
- Follow existing patterns for imports using `@/` alias

### Code Formatting

The project uses Prettier for code formatting:

```bash
# Format code (if configured)
npm run format

# Check formatting
npm run format:check
```

### Linting

ESLint is used for code linting:

```bash
# Lint code
npm run lint

# Auto-fix linting issues
npm run lint:fix
```

## Documentation

### Updating Documentation

When adding features:

1. Update relevant documentation in `docs/`
2. Update the main README.md if needed
3. Add examples to demonstrate new functionality
4. Ensure all code examples are tested

### Documentation Structure

```
docs/
├── commands.md           # Command reference
├── quick-start.md        # Getting started guide
├── installation.md       # Installation instructions
├── monorepo_support.md   # Workspace/monorepo documentation
├── troubleshooting.md    # Common issues and solutions
└── contributing.md       # This file
```

## Pull Request Process

### Before Submitting

1. Ensure all tests pass
2. Update documentation if needed
3. Add tests for new features
4. Run linting and formatting
5. Test with different package managers if applicable

### PR Template

```markdown
## Description

Brief description of changes

## Type of Change

- [ ] Bug fix
- [ ] New feature
- [ ] Documentation update
- [ ] Refactoring

## Testing

- [ ] Unit tests added/updated
- [ ] Manual testing completed
- [ ] Tested with multiple package managers (if applicable)

## Documentation

- [ ] Documentation updated
- [ ] Examples added/updated
```

## Areas for Contribution

### High Priority

1. **Package Manager Support**: Complete yarn, pnpm, and bun implementations
2. **Migration System**: Build out the migration rule system
3. **Error Handling**: Improve error messages and handling
4. **Testing**: Add comprehensive tests for existing functionality

### Medium Priority

1. **PR Generation**: Build the GitHub integration system
2. **Configuration**: Add configuration file support
3. **Interactive Mode**: Add interactive package selection
4. **Logging**: Enhance logging and debugging capabilities

### Low Priority

1. **Performance**: Optimize for large projects
2. **CI/CD**: Improve build and release processes
3. **Documentation**: Expand examples and guides

## Getting Help

### Resources

- **Issues**: Report bugs or request features
- **Discussions**: Ask questions or share ideas
- **Documentation**: Check existing docs first

### Issue Templates

When creating issues:

- **Bug Report**: Include error messages, OS, Node.js version, package manager
- **Feature Request**: Describe the use case and expected behavior
- **Documentation**: Suggest improvements or report unclear sections

Thank you for contributing to Always Up To Date! 🎉
