# Documentation Index

Welcome to the Always Up To Date documentation! Choose a topic below to get started.

## Getting Started

- 📦 **[Installation Guide](./installation.md)** - How to install and set up Always Up To Date
- 🚀 **[Quick Start Guide](./quick-start.md)** - Get up and running in 5 minutes

## Core Features

- 🛠️ **[Commands Reference](./commands.md)** - Complete documentation for all available commands
- 🏢 **[Monorepo Support](./monorepo_support.md)** - Support for npm workspaces and monorepo structures

## Support & Development

- 🛠️ **[Troubleshooting Guide](./troubleshooting.md)** - Common issues and solutions
- 🤝 **[Contributing Guide](./contributing.md)** - Help improve the project

## Quick Reference

### Available Commands

```bash
# Check for outdated dependencies
npx alwaysuptodate check

# Update outdated dependencies
npx alwaysuptodate update

# Show help information
npx alwaysuptodate help

# Apply migrations (coming soon)
npx alwaysuptodate migrate
```

### Package Manager Support

Always Up To Date automatically detects your package manager:

- **npm** - Detects `package-lock.json`
- **yarn** - Detects `yarn.lock`
- **pnpm** - Detects `pnpm-lock.yaml`
- **bun** - Detects `bun.lock`

### Workspace Support

- ✅ **npm workspaces** - Fully supported
- ✅ **yarn workspaces** - Fully supported
- ✅ **pnpm workspaces** - Fully supported
- ✅ **bun workspaces** - Fully supported

## Current Implementation Status

### ✅ Available Now

- Package manager auto-detection (npm, yarn, pnpm, bun)
- Basic dependency checking and updating
- Full workspace support for all package managers
- Modular architecture for extensibility

### 🚧 In Development

- Smart migration system with framework-specific rules
- Automated PR generation for GitHub integration

### 📋 Planned Features

- Advanced configuration options
- Interactive update selection
- Security vulnerability scanning
- Rollback functionality
- Enhanced error handling and logging

---

**Need help?** Check out our [Troubleshooting Guide](./troubleshooting.md) or [Contributing Guide](./contributing.md) for support options.
