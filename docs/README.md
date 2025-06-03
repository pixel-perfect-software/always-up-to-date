# Documentation Index

Welcome to the Always Up To Date documentation! Choose a topic below to get started.

## Getting Started

- 📦 **[Installation Guide](./installation.md)** - How to install and set up Always Up To Date
- 🚀 **[Quick Start Guide](./quick-start.md)** - Get up and running in 5 minutes

## Core Features

- 🛠️ **[Commands Reference](./commands.md)** - Complete documentation for all commands
- ⚙️ **[Configuration Guide](./configuration.md)** - Customize behavior with configuration files
- 🔒 **[Safety Features](./safety-features.md)** - Backup, rollback, and security features

## Advanced Usage

- 🐙 **[GitHub Integration](./github-integration.md)** - Automated PR creation and CI/CD workflows
- 📦 **[Monorepo Support](./monorepo_support.md)** - Support for npm, yarn, and pnpm workspaces
- 🗂️ **[pnpm Catalog Support](./pnpm-catalog.md)** - Centralized dependency management with pnpm catalogs
- 🤝 **[Contributing Guide](./contributing.md)** - Help improve the project

## Support

- 🛠️ **[Troubleshooting Guide](./troubleshooting.md)** - Common issues and solutions

## Quick Reference

### Most Common Commands

```bash
# Check for updates
npx alwaysuptodate check --preview

# Interactive update selection
npx alwaysuptodate check --interactive

# Auto-update with GitHub PR
npx alwaysuptodate auto --createIssue

# Security audit
npx alwaysuptodate audit

# Rollback changes
npx alwaysuptodate rollback
```

### Essential Configuration

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

---

**Need help?** Check out our [Contributing Guide](./contributing.md) for support options.
