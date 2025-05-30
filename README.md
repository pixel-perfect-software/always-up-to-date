# Always Up To Date

[![CI](https://github.com/TylerNRobertson/always-up-to-date/workflows/CI/badge.svg)](https://github.com/TylerNRobertson/always-up-to-date/actions/workflows/ci.yml)
[![Security](https://github.com/TylerNRobertson/always-up-to-date/workflows/Security/badge.svg)](https://github.com/TylerNRobertson/always-up-to-date/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

A highly customizable and reusable dependency checker that keeps your npm dependencies always up to date. This CLI tool automatically manages dependency updates, handles breaking changes gracefully, and integrates seamlessly with your development workflow.

## ✨ Features

- 🚀 **Automatic Dependency Updates** - Daily checks with intelligent updates
- 🔒 **Vulnerability Scanning** - Built-in security audit capabilities
- 📊 **Detailed Reporting** - Comprehensive diff views and change tracking
- 🔄 **Smart Rollback** - Safe recovery from problematic updates
- 🎯 **GitHub Integration** - Automatic PR creation with migration guides
- ⚙️ **Highly Configurable** - Granular control over update strategies
- 📦 **Multi Package Manager** - Supports npm, yarn, pnpm, and more
- 🎨 **Interactive Mode** - User-friendly prompts and confirmations

## 🚀 Quick Start

### Installation

```bash
# Global installation (recommended)
npm install -g always-up-to-date

# Or using other package managers
yarn global add always-up-to-date
pnpm add -g always-up-to-date

# Or use npx for one-time usage
npx always-up-to-date check
```

### Basic Usage

```bash
# Check for outdated dependencies
alwaysuptodate check

# Or use the full command name
always-up-to-date check

# Audit for vulnerabilities
alwaysuptodate audit

# Auto-update with PR creation
alwaysuptodate auto --create-pr

# Show help
alwaysuptodate --help
```

### Installation

```bash
# Install globally
npm install -g always-up-to-date

# Or use locally in your project
npm install --save-dev always-up-to-date
```

### Basic Usage

```bash
# Check for outdated dependencies
npx alwaysuptodate check

# Audit for vulnerabilities
npx alwaysuptodate audit

# Auto-update with PR creation
npx alwaysuptodate auto --createIssue
```

## 📚 Commands

### `check` - Check for Updates

Check which dependencies can be updated without making any changes.

```bash
npx alwaysuptodate check [options]
```

**Options:**

- `-p, --projectPath <path>` - Path to project directory
- `-v, --verbose` - Show verbose output
- `--preview` - Preview mode (show what would be updated)
- `--interactive` - Interactive mode with prompts

**Examples:**

```bash
# Basic check
npx alwaysuptodate check

# Check with preview of changes
npx alwaysuptodate check --preview

# Interactive check with prompts
npx alwaysuptodate check --interactive
```

### `audit` - Security Audit

Scan dependencies for known security vulnerabilities.

```bash
npx alwaysuptodate audit [options]
```

**Options:**

- `-p, --projectPath <path>` - Path to project directory
- `-v, --verbose` - Show verbose output

**Example:**

```bash
npx alwaysuptodate audit --verbose
```

### `auto` - Automatic Updates

Automatically update dependencies and optionally create pull requests.

```bash
npx alwaysuptodate auto [options]
```

**Options:**

- `-p, --projectPath <path>` - Path to project directory
- `-c, --createIssue` - Create pull request with updates
- `-t, --token <token>` - GitHub token for PR creation
- `-r, --repository <owner/repo>` - GitHub repository
- `--dry-run` - Show what would be done without changes
- `--batch-size <size>` - Number of packages per batch (default: 10)
- `--separate-prs` - Create separate PRs for major updates
- `-v, --verbose` - Show verbose output

**Examples:**

```bash
# Auto-update without PRs
npx alwaysuptodate auto

# Auto-update with PR creation
npx alwaysuptodate auto --createIssue --token $GITHUB_TOKEN --repository owner/repo

# Dry run to see what would happen
npx alwaysuptodate auto --dry-run

# Process updates in smaller batches
npx alwaysuptodate auto --batch-size 5 --separate-prs
```

### `diff` - Show Changes

Display detailed differences between current and available versions.

```bash
npx alwaysuptodate diff [options]
```

**Options:**

- `-p, --projectPath <path>` - Path to project directory
- `--format <format>` - Output format: `table`, `json`, or `detailed` (default)
- `-v, --verbose` - Show verbose output

**Examples:**

```bash
# Detailed diff view (default)
npx alwaysuptodate diff

# Table format
npx alwaysuptodate diff --format table

# JSON output for scripting
npx alwaysuptodate diff --format json
```

### `rollback` - Undo Changes

Rollback recent dependency updates using automatic backups.

```bash
npx alwaysuptodate rollback [options]
```

**Options:**

- `-p, --projectPath <path>` - Path to project directory
- `--keep-backup` - Keep backup file after rollback
- `-v, --verbose` - Show verbose output

**Example:**

```bash
npx alwaysuptodate rollback --keep-backup
```

### `init` - Create Configuration

Generate a sample configuration file for customization.

```bash
npx alwaysuptodate init [options]
```

**Options:**

- `-p, --projectPath <path>` - Path to project directory

**Example:**

```bash
npx alwaysuptodate init
```

## ⚙️ Configuration

Create an `always-up-to-date.config.json` file in your project root:

```json
{
  "autoUpdate": true,
  "createPRs": true,
  "ignoredPackages": ["legacy-package"],
  "includeDev": true,
  "onlyDirect": false,
  "baseBranch": "main",
  "updateStrategy": "minor",
  "packageRules": [
    {
      "name": "react*",
      "updateStrategy": "minor",
      "autoUpdate": true
    },
    {
      "name": "@types/*",
      "updateStrategy": "patch",
      "autoUpdate": true
    }
  ],
  "schedule": {
    "enabled": true,
    "cron": "0 9 * * 1",
    "includeWeekends": false
  },
  "notifications": {
    "slack": {
      "webhook": "https://hooks.slack.com/...",
      "channel": "#dev-updates"
    }
  }
}
```

### Configuration Options

| Option            | Type     | Default | Description                                         |
| ----------------- | -------- | ------- | --------------------------------------------------- |
| `autoUpdate`      | boolean  | `true`  | Enable automatic updates                            |
| `createPRs`       | boolean  | `false` | Create GitHub PRs for updates                       |
| `ignoredPackages` | string[] | `[]`    | Packages to never update                            |
| `includeDev`      | boolean  | `true`  | Include devDependencies                             |
| `onlyDirect`      | boolean  | `false` | Only update direct dependencies                     |
| `updateStrategy`  | string   | `minor` | Default update strategy (`major`, `minor`, `patch`) |
| `baseBranch`      | string   | `main`  | Base branch for PRs                                 |

## 🔧 Environment Variables

Set these environment variables for GitHub integration:

```bash
export GITHUB_TOKEN="your-github-token"
export REPO_OWNER="your-username"
export REPO_NAME="your-repository"
```

## 🛠 Package Manager Support

The tool automatically detects and works with:

- **npm** - Uses `package-lock.json`
- **yarn** - Uses `yarn.lock`
- **pnpm** - Uses `pnpm-lock.yaml`
- **bun** - Uses `bun.lockb`

## 🚨 Error Handling & Rollback

The tool creates automatic backups before making changes:

- `package.json.backup` - Original package.json
- `.always-up-to-date/` - Metadata and logs

If something goes wrong, use the rollback command:

```bash
npx alwaysuptodate rollback
```

## 📈 Examples

### CI/CD Integration

This project includes several GitHub Actions workflows for comprehensive automation:

#### Dependency Updates (Weekly)

```yaml
# .github/workflows/dependencies.yml
name: Update Dependencies
on:
  schedule:
    - cron: "0 9 * * 1" # Monday at 9 AM UTC
  workflow_dispatch: # Manual trigger

permissions:
  contents: write
  pull-requests: write

jobs:
  update-dependencies:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: "pnpm"
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: |
          npx alwaysuptodate auto \
            --createIssue \
            --token ${{ secrets.GITHUB_TOKEN }} \
            --repository ${{ github.repository }} \
            --batch-size 5 \
            --separate-prs
        env:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
```

#### For Your Projects

Copy this workflow to automatically update dependencies in your repositories:

```yaml
# .github/workflows/auto-updates.yml
name: Auto Update Dependencies
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

### Package-Specific Rules

```json
{
  "packageRules": [
    {
      "name": "react",
      "updateStrategy": "minor",
      "autoUpdate": false
    },
    {
      "name": "@types/*",
      "updateStrategy": "patch",
      "autoUpdate": true
    },
    {
      "name": "eslint*",
      "updateStrategy": "minor",
      "ignoredVersions": ["8.0.0"]
    }
  ]
}
```

## 🤝 Contributing

Contributions are welcome! Please:

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## 📝 License

MIT © [Tyler Robertson](https://github.com/TylerNRobertson)
This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
