# Contributing Guide

We welcome contributions to Always Up To Date! This guide will help you get started.

## Getting Started

### Prerequisites

- Node.js 18 or higher
- pnpm (preferred) or npm
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
   ```

4. **Run tests**:

   ```bash
   pnpm test
   ```

5. **Build the project**:
   ```bash
   pnpm build
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
   pnpm lint
   ```

5. Commit with conventional commits:

   ```bash
   git commit -m "feat: add new migration rule for package X"
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
├── cli.ts              # CLI entry point
├── commands/           # Command implementations
│   ├── check.ts
│   ├── audit.ts
│   ├── auto.ts
│   └── ...
├── services/           # Core business logic
│   ├── dependency-checker.ts
│   ├── migration-advisor.ts
│   └── ...
└── utils/              # Utility functions
    ├── logger.ts
    ├── config.ts
    └── ...
```

## Testing

### Test Types

- **Unit tests**: Test individual functions and classes
- **Integration tests**: Test command interactions
- **E2E tests**: Test full CLI workflows

### Running Tests

```bash
# All tests
pnpm test

# Watch mode
pnpm test:watch

# Coverage report
pnpm test:coverage

# Specific test file
pnpm test check.test.ts
```

### Writing Tests

Use Jest with the existing patterns:

```typescript
import { checkCommand } from "../src/commands/check";

describe("check command", () => {
  it("should detect outdated dependencies", async () => {
    // Test implementation
  });
});
```

## Adding New Features

### Adding a New Command

1. Create command file in `src/commands/`
2. Implement the command logic
3. Add CLI argument parsing
4. Write tests
5. Update documentation

### Adding Migration Rules

1. Add rule to `src/services/migration-rules/`
2. Follow the existing pattern:

```typescript
export const reactMigrationRules = {
  "17.0.0": {
    "18.0.0": {
      breakingChanges: [
        "Automatic batching behavior changed",
        "New JSX transform required",
      ],
      migrationSteps: [
        "Update React types",
        "Review component lifecycle methods",
      ],
      learnMore: "https://react.dev/blog/2022/03/29/react-v18",
    },
  },
};
```

3. Register the rule in the migration advisor
4. Write tests for the new rules

### Adding Package Manager Support

1. Create handler in `src/services/package-managers/`
2. Implement the `PackageManager` interface
3. Add detection logic to `src/utils/package-manager.ts`
4. Write tests for the new package manager

## Documentation

### Types of Documentation

- **README**: Main project overview
- **API Documentation**: Code documentation
- **User Guides**: How-to documentation
- **Examples**: Usage examples

### Writing Documentation

- Use clear, concise language
- Include code examples
- Add screenshots for UI features
- Test all code examples

### Documentation Structure

```
docs/
├── installation.md
├── quick-start.md
├── commands.md
├── configuration.md
├── safety-features.md
├── github-integration.md
└── contributing.md
```

## Code Style

### TypeScript Guidelines

- Use strict TypeScript configuration
- Prefer interfaces over types for object shapes
- Use proper typing (avoid `any`)
- Document complex types

### Code Formatting

We use Prettier for code formatting:

```bash
# Format code
pnpm format

# Check formatting
pnpm format:check
```

### Linting

ESLint is used for code linting:

```bash
# Lint code
pnpm lint

# Auto-fix linting issues
pnpm lint:fix
```

## Pull Request Process

### Before Submitting

1. Ensure all tests pass
2. Update documentation if needed
3. Add or update tests for new features
4. Run linting and formatting
5. Write a clear PR description

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
- [ ] Integration tests added/updated
- [ ] Manual testing completed

## Documentation

- [ ] Documentation updated
- [ ] Examples added/updated
```

### Review Process

1. Automated checks must pass
2. Code review by maintainers
3. Address feedback
4. Final approval and merge

## Release Process

Releases are automated using semantic versioning:

1. Merge PRs to `main`
2. GitHub Actions automatically:
   - Runs tests
   - Builds the package
   - Publishes to npm
   - Creates GitHub release
   - Updates changelog

## Getting Help

### Resources

- **Issues**: Report bugs or request features
- **Discussions**: Ask questions or share ideas
- **Discord**: Join our community chat
- **Email**: Contact maintainers directly

### Issue Templates

Use appropriate issue templates:

- **Bug Report**: For reporting bugs
- **Feature Request**: For requesting new features
- **Documentation**: For documentation improvements

### Support Channels

1. **GitHub Issues**: Primary support channel
2. **GitHub Discussions**: Community Q&A
3. **Email**: For security issues or private matters

## Recognition

Contributors are recognized in:

- **CHANGELOG.md**: For each release
- **README.md**: All-time contributors
- **GitHub**: Contributor graphs and stats

Thank you for contributing to Always Up To Date! 🎉
