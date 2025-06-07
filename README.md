<p align="center">
  <img src="./assets/logo.svg" />
</p>
<hr />

# Always Up To Date

[![CI](https://github.com/pixel-perfect-software/always-up-to-date/workflows/CI/badge.svg)](https://github.com/pixel-perfect-software/always-up-to-date/actions/workflows/ci.yml)
[![Security](https://github.com/pixel-perfect-software/always-up-to-date/workflows/Security/badge.svg)](https://github.com/pixel-perfect-software/always-up-to-date/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A smart CLI tool that automatically keeps your dependencies up to date with intelligent package manager detection and workspace support.

## ✨ Features

- 📦 **Universal Package Manager Support** - Automatically detects and works with npm, yarn, pnpm, and bun
- 🔍 **Dependency Checking** - Check for outdated packages across your project
- 🚀 **Smart Updates** - Update packages while respecting workspace configurations
- 🏢 **Workspace Support** - Full support for npm workspaces and monorepo structures
- 🎯 **Intelligent Detection** - Automatically detects your package manager from lock files
- 🛠️ **Extensible Architecture** - Modular design with dedicated managers, migrators, and PR generators

## 🏗️ Architecture

The tool is built with a modular architecture:

- **Managers** - Package manager specific implementations (npm, yarn, pnpm, bun)
- **Migrators** - Smart migration rules for popular packages (React, Next.js, etc.)
- **PR Generators** - Automated pull request creation with detailed migration guides
- **Command Runner** - Unified command execution across all package managers

## 🔜 Coming Soon

- Enhanced migration rules for popular frameworks
- GitHub integration with automated PR creation
- Advanced configuration options
- Security vulnerability scanning
- Interactive update selection

## 🚀 Quick Start

```bash
# Global installation (recommended)
npm install -g always-up-to-date

# Check for outdated dependencies
npx alwaysuptodate check

# Update outdated dependencies
npx alwaysuptodate update

# Migrate packages with breaking changes (coming soon)
npx alwaysuptodate migrate
```

## 📖 Documentation

- 📦 **[Installation Guide](./docs/installation.md)** - Detailed installation instructions and troubleshooting
- 🚀 **[Quick Start Guide](./docs/quick-start.md)** - Get up and running in minutes
- 🛠️ **[Commands Reference](./docs/commands.md)** - Complete command documentation with examples
- 🏢 **[Monorepo Support](./docs/monorepo_support.md)** - Workspace and monorepo documentation
- 🛠️ **[Troubleshooting Guide](./docs/troubleshooting.md)** - Common issues and solutions
- 🤝 **[Contributing Guide](./docs/contributing.md)** - How to contribute to the project
- � **[Documentation Index](./docs/README.md)** - Complete documentation overview

## 🔧 Basic Usage Examples

```bash
# Check for outdated dependencies
npx alwaysuptodate check

# Update all outdated dependencies
npx alwaysuptodate update

# Get help and see all available commands
npx alwaysuptodate help
```

## 📦 Package Manager Detection

The tool automatically detects your package manager by looking for lock files:

- **npm** - `package-lock.json`
- **yarn** - `yarn.lock`
- **pnpm** - `pnpm-lock.yaml`
- **bun** - `bun.lock`

## 🏢 Workspace Support

Full support for workspaces and monorepos:

- **npm workspaces** - Automatically detected from `package.json` workspaces field
- **yarn workspaces** - Automatically detected from `package.json` workspaces field
- **pnpm workspaces** - Automatically detected from `pnpm-workspace.yaml`
- **bun workspaces** - Automatically detected from `package.json` workspaces field

## 🛠️ Available Commands

- `check` - Check for outdated dependencies in your project
- `update` - Update all outdated dependencies
- `migrate` - Migrate packages with breaking changes (coming soon)
- `help` - Display help information

## ⚙️ Current Implementation

The current implementation provides:

- ✅ Package manager auto-detection
- ✅ Dependency version checking
- ✅ Package updating with workspace support
- ✅ Modular architecture for extensibility
- 🚧 Migration system (in development)
- 🚧 PR generation (in development)
- 🚧 Advanced configuration (planned)

## 🤝 Contributing

Contributions are welcome! Please see our [Contributing Guide](./docs/contributing.md) for details on how to get started.

## 💸 Support this package's development & maintenance

<a href="https://www.buymeacoffee.com/tylernrobertson" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png" alt="Buy Me A Coffee" style="height: 50px !important;width: 217px !important;" >

## 📝 License

MIT © [Tyler Robertson](https://github.com/TylerNRobertson) - See [LICENSE](LICENSE) for details.
