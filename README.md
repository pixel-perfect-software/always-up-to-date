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
- 🧠 **Smart Migration Advisor** - Provides detailed migration instructions for popular packages (React, Next.js, TypeScript, ESLint, Jest, Prettier)
- 🔄 **Interactive Mode** - Choose exactly which packages to update
- 📊 **Multiple Output Formats** - Table, JSON, or detailed diff views
- 🔍 **Preview Mode** - See detailed update plans before applying changes

## 🚨 Safety Features

- **Automatic Backups** - Creates `package.json.backup` before changes
- **Smart Rollback** - `npx alwaysuptodate rollback` to undo changes
- **Package Manager Detection** - Works with npm, yarn, pnpm, bun
- **Vulnerability Scanning** - Security audit integration
- **Migration Advisor** - Detailed upgrade instructions for popular packages:
  - React (17→18, etc.)
  - Next.js (13→14, etc.)
  - TypeScript (4→5, etc.)
  - ESLint (8→9, etc.)
  - Jest (28→29, etc.)
  - Prettier (2→3, etc.)
- **Breaking Change Detection** - Identifies major version updates requiring manual review
- **Interactive Selection** - Choose exactly which updates to apply

## Support this packages development / maintenance

This tool is provided under MIT License and is free for use.

However, if you would like to support the development/maintenance of this package, you can "Buy Me A Coffee" below!

[!["Buy Me A Coffee"](https://www.buymeacoffee.com/assets/img/custom_images/orange_img.png)](https://www.buymeacoffee.com/tylernrobertson)

## 🚀 Quick Start

### Installation

```bash
# Global installation (recommended)
npm install -g always-up-to-date

# Or use npx for one-time usage
npx always-up-to-date check
```

### Basic Usage

```bash
# Check for outdated dependencies
npx alwaysuptodate check

# Audit for vulnerabilities
npx alwaysuptodate audit

# Auto-update with GitHub PR creation
npx alwaysuptodate auto --createIssue

# Interactive mode with prompts
npx alwaysuptodate check --interactive
```

## 🔧 GitHub Authentication

Authentication is handled automatically! The tool detects credentials from:

1. Command line (`--token` flag)
2. VS Code GitHub authentication
3. Environment variables (`GITHUB_TOKEN`)
4. Environment files (`.env`)

### Quick Setup

```bash
# Option 1: Use environment variable
export GITHUB_TOKEN="your_token_here"

# Option 2: Create .env file
echo "GITHUB_TOKEN=your_token_here" > .env

# Option 3: Pass token directly
npx alwaysuptodate auto --createIssue --token your_token_here
```

[Create a GitHub token](https://github.com/settings/tokens) with `repo` and `workflow` scopes.

## 📚 Commands

| Command    | Description                           | Example                                  |
| ---------- | ------------------------------------- | ---------------------------------------- |
| `check`    | Check for outdated dependencies       | `npx alwaysuptodate check --preview`     |
| `audit`    | Scan for security vulnerabilities     | `npx alwaysuptodate audit`               |
| `auto`     | Auto-update with optional PR creation | `npx alwaysuptodate auto --createIssue`  |
| `diff`     | Show detailed version differences     | `npx alwaysuptodate diff --format table` |
| `rollback` | Undo recent changes                   | `npx alwaysuptodate rollback`            |
| `init`     | Create configuration file             | `npx alwaysuptodate init`                |

### Common Options

- `-p, --projectPath <path>` - Specify project directory
- `-v, --verbose` - Show detailed output
- `--dry-run` - Preview changes without applying
- `--interactive` - Enable interactive prompts

### Command-Specific Options

#### `check` Command

- `--preview` - Show detailed report without making changes
- `--interactive` - Select specific packages to update

#### `auto` Command

- `-c, --createIssue` - Create GitHub PR with updates
- `-t, --token <token>` - GitHub token (auto-detected if not provided)
- `-r, --repository <owner/repo>` - GitHub repository (auto-detected if not provided)
- `--batch-size <size>` - Number of packages to update per batch (default: 10)
- `--separate-prs` - Create separate PRs for each major update

#### `diff` Command

- `--format <format>` - Output format: `table`, `json`, or `detailed` (default: detailed)

#### `rollback` Command

- `--keep-backup` - Keep backup file after rollback

## ⚙️ Configuration

Create `.alwaysuptodate.json` for advanced customization:

```json
{
  "autoUpdate": false,
  "createPRs": true,
  "updateStrategy": "minor",
  "ignoredPackages": ["@types/node", "typescript"],
  "includeDev": true,
  "onlyDirect": false,
  "packageRules": [
    {
      "name": "react",
      "updateStrategy": "minor",
      "autoUpdate": false,
      "ignoredVersions": ["19.0.0-beta.1"]
    },
    {
      "name": "@types/*",
      "updateStrategy": "patch",
      "autoUpdate": true
    }
  ],
  "baseBranch": "main",
  "batchSize": 10,
  "parallelUpdates": false,
  "createSeparatePRs": false,
  "confirmBeforeUpdate": false
}
```

### Configuration Options

- `autoUpdate` - Enable automatic updates without prompts
- `createPRs` - Automatically create GitHub PRs
- `updateStrategy` - Default strategy: `major`, `minor`, `patch`
- `ignoredPackages` - Packages to skip during updates
- `packageRules` - Package-specific update rules with pattern matching
- `batchSize` - Number of packages to update simultaneously
- `parallelUpdates` - Enable parallel processing
- `createSeparatePRs` - Create individual PRs for major updates

## 🔄 CI/CD Integration

Add to your GitHub Actions workflow:

```yaml
name: Update Dependencies
on:
  schedule:
    - cron: "0 9 * * 1" # Weekly on Monday

jobs:
  update:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
      - run: npx always-up-to-date auto --createIssue
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

## 🤝 Contributing

Contributions are welcome! Please fork the repository, create a feature branch, and submit a pull request.

## 📝 License

MIT © [Tyler Robertson](https://github.com/TylerNRobertson) - See [LICENSE](LICENSE) for details.
