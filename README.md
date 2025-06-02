<p align="center">
  <img src="./assets/logo.svg" />
</p>
<hr />

# Always Up To Date

[![CI](https://github.com/pixel-perfect-software/always-up-to-date/workflows/CI/badge.svg)](https://github.com/pixel-perfect-software/always-up-to-date/actions/workflows/ci.yml)
[![Security](https://github.com/pixel-perfect-software/always-up-to-date/workflows/Security/badge.svg)](https://github.com/pixel-perfect-software/always-up-to-date/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A smart CLI tool that automatically keeps your npm dependencies up to date with vulnerability scanning, GitHub integration, and intelligent rollback capabilities.

## ✨ Features

- 🚀 **Automatic Updates** - Smart dependency management with breaking change detection
- 🔒 **Security First** - Built-in vulnerability scanning and safe rollback
- 🎯 **GitHub Integration** - Auto-creates PRs with detailed migration guides
- 📦 **Universal Support** - Works with npm, yarn, pnpm, and bun
- ⚙️ **Highly Configurable** - Granular control over update strategies
- 🧠 **Smart Migration Advisor** - Detailed migration instructions for popular packages
- 🔄 **Interactive Mode** - Choose exactly which packages to update
- 📊 **Multiple Output Formats** - Table, JSON, or detailed diff views
- 🔍 **Preview Mode** - See detailed update plans before applying changes>

## 🔜 Coming Soon

- Monorepo support (turborepo, lerna, rush, etc)
- Workspace dependencies
- PNPM Catalog support

## 🚀 Quick Start

```bash
# Global installation (recommended)
npm install -g always-up-to-date

# Check for outdated dependencies
npx alwaysuptodate check

# Auto-update with GitHub PR creation
npx alwaysuptodate auto --createIssue
```

## 📖 Documentation

- 📦 **[Installation Guide](./docs/installation.md)** - Detailed installation instructions and troubleshooting
- 🚀 **[Quick Start Guide](./docs/quick-start.md)** - Get up and running in minutes
- 🛠️ **[Commands Reference](./docs/commands.md)** - Complete command documentation with examples
- ⚙️ **[Configuration Guide](./docs/configuration.md)** - Advanced configuration options and examples
- 🔒 **[Safety Features](./docs/safety-features.md)** - Backup, rollback, and security features
- 🐙 **[GitHub Integration](./docs/github-integration.md)** - PR creation and CI/CD setup
- 🛠️ **[Troubleshooting Guide](./docs/troubleshooting.md)** - Common issues and solutions
- 🤝 **[Contributing Guide](./docs/contributing.md)** - How to contribute to the project

## 🔧 Basic Usage Examples

```bash
# Interactive mode - choose which packages to update
npx alwaysuptodate check --interactive

# Preview changes without applying them
npx alwaysuptodate check --preview

# Audit for security vulnerabilities
npx alwaysuptodate audit

# Rollback recent changes
npx alwaysuptodate rollback
```

## 🚨 Safety Features

- **Automatic Backups** - Creates `package.json.backup` before changes
- **Smart Rollback** - Easy undo with `rollback` command
- **Breaking Change Detection** - Identifies major version updates
- **Vulnerability Scanning** - Built-in security audit
- **Interactive Selection** - Choose exactly which updates to apply

**[→ Learn more about safety features](./docs/safety-features.md)**

## 🔧 GitHub Integration

Set up automated dependency updates with GitHub PR creation:

```bash
# Quick setup with environment variable
export GITHUB_TOKEN="your_token_here"
npx alwaysuptodate auto --createIssue
```

**[→ Complete GitHub integration guide](./docs/github-integration.md)**

## ⚙️ Configuration

Create `.alwaysuptodate.json` for advanced customization:

```json
{
  "updateStrategy": "minor",
  "ignoredPackages": ["@types/node"],
  "packageRules": [
    {
      "name": "react",
      "updateStrategy": "minor",
      "autoUpdate": false
    }
  ]
}
```

**[→ See full configuration options](./docs/configuration.md)**

## 🤝 Contributing

Contributions are welcome! Please see our [Contributing Guide](./docs/contributing.md) for details on how to get started.

## 💸 Support this package's development & maintenance

<a href="https://www.buymeacoffee.com/tylernrobertson" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png" alt="Buy Me A Coffee" style="height: 50px !important;width: 217px !important;" >

## 📝 License

MIT © [Tyler Robertson](https://github.com/TylerNRobertson) - See [LICENSE](LICENSE) for details.
