<p align="center">
  <img src="./assets/logo.svg" />
</p>
<hr />

# Always Up To Date

[![CI](https://github.com/pixel-perfect-software/always-up-to-date/workflows/CI/badge.svg)](https://github.com/pixel-perfect-software/always-up-to-date/actions/workflows/ci.yml)
[![Security](https://github.com/pixel-perfect-software/always-up-to-date/workflows/Security/badge.svg)](https://github.com/pixel-perfect-software/always-up-to-date/actions/workflows/security.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
![Coverage: statements](https://raw.githubusercontent.com/pixel-perfect-software/always-up-to-date/main/badges/badge-statements.svg)
![Coverage: branches](https://raw.githubusercontent.com/pixel-perfect-software/always-up-to-date/main/badges/badge-branches.svg)
![Coverage: functions](https://raw.githubusercontent.com/pixel-perfect-software/always-up-to-date/main/badges/badge-functions.svg)
![Coverage: lines](https://raw.githubusercontent.com/pixel-perfect-software/always-up-to-date/main/badges/badge-lines.svg)

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
- **Migrators** - Smart migration rules for popular packages (React, Next.js, etc.) (Coming Soon!)
- **PR Generators** - Automated pull request creation with detailed migration guides (Coming Soon!)
- **Command Runner** - Unified command execution across all package managers

## 🔜 Coming Soon

- Migration rules for popular frameworks (React, Next.js, etc.)
- GitHub integration with automated PR creation
- Security vulnerability scanning

## 📋 Requirements

- **Node.js** 24 or higher
- One of: **npm**, **yarn**, **pnpm** (10+), or **bun**

## 🚀 Quick Start

```bash
# Global installation (recommended)
npm install -g @pixel-perfect-software/always-up-to-date

# Initialize the library
autd init

# Check for outdated dependencies
autd check

# Update outdated dependencies
autd update
```

## 🔧 Usage Examples

```bash
# Check for outdated dependencies
autd check

# Check with JSON output (useful for CI/CD pipelines)
autd check --json

# Update all eligible dependencies
autd update

# Update specific packages only
autd update react lodash @babel/core

# Preview what would be updated without making changes
autd update --dry-run

# Interactively select which packages to update
autd update --interactive

# Combine flags: dry-run specific packages with JSON output
autd update react --dry-run --json

# Get help and see all available commands
autd help
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

| Command | Description |
|---------|-------------|
| `autd init` | Initialize configuration in the current directory |
| `autd check` | Check for outdated dependencies in your project |
| `autd check --json` | Output outdated packages as JSON |
| `autd update` | Update all eligible dependencies |
| `autd update [packages...]` | Update only the specified packages |
| `autd update --dry-run` | Preview which packages would be updated |
| `autd update -i, --interactive` | Interactively select packages to update |
| `autd update --json` | Output update results as JSON |
| `autd help` | Display help information |

## ⚙️ Configuration

By default, `autd update` stays within the version range each dependency has in `package.json`, the same set `npm update` would install. `"^18.2.0"` can move to the newest `18.x`, `"~7.5.0"` to the newest `7.5.x`, and an exact pin like `"1.11.9"` is left alone. You only need a config file to go further.

Run `autd init` to create `.always-up-to-date.json` in your project root:

```json
{
  "beyondRange": "none",
  "rules": {},
  "cooldown": 0,
  "debug": false,
  "silent": false
}
```

| Option | Default | Description |
|--------|---------|-------------|
| `beyondRange` | `"none"` | How far past its range a dependency may move, to its latest version: `"none"`, `"patch"`, `"minor"` or `"major"`. Applies to exact pins too, so `"patch"` moves `"1.11.9"` to `"1.11.23"`. |
| `rules` | `{}` | Per-package overrides (see below). |
| `cooldown` | `0` | Skip versions published more recently than this: days (`7`), a duration (`"1 week"`, `"24h"`), or per update type (`{ "major": "30 days" }`). |
| `debug` | `false` | Enable debug logging |
| `silent` | `false` | Suppress all output |

### Rules

`rules` overrides the policy for single packages or groups:

```json
{
  "beyondRange": "minor",
  "rules": {
    "react": "hold",
    "typescript": "latest",
    "@types/*": "followRange"
  }
}
```

| Rule | Effect |
|------|--------|
| `"hold"` | Never update this package. |
| `"followRange"` | Stay within the range, even when `beyondRange` allows more. |
| `"latest"` | Always move to the latest version, whatever the range or step size. |

Keys are package names or `*` globs (`"@types/*"`, `"eslint-*"`, `"*"`). An exact name beats a glob, and among globs the longest pattern wins.

A package your package manager pins with an override is held when the update would leave the override's range, with the reason `controlled by …`: npm `overrides`, yarn berry `resolutions`, pnpm `overrides` in `pnpm-workspace.yaml`, and bun `overrides` or `resolutions`.

When a dependency moves past its range, its spec keeps its decorator: `"^18.2.0"` becomes `"^19.3.1"` and `"1.11.9"` becomes `"1.11.23"`. Run `autd update --dry-run` to see where each package would move, or why it is held.

### Older config files

These fields still work, and `beyondRange` and `rules` win when both are set:

| Old field | Same as |
|-----------|---------|
| `"allowMinorUpdates": true` | `"beyondRange": "minor"` |
| `"allowMajorUpdates": true` | `"beyondRange": "major"` |
| `"updateAllowlist": ["x"]` | `"rules": { "x": "latest" }` |
| `"updateDenylist": ["x"]` | `"rules": { "x": "hold" }` |

## 🤝 Contributing

Contributions are welcome! Please see our [Contributing Guide](./docs/contributing.md) for details on how to get started.

## 💸 Support this package's development & maintenance

<a href="https://www.buymeacoffee.com/tylernrobertson" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png" alt="Buy Me A Coffee" style="height: 50px !important;width: 217px !important;" >

## 📝 License

MIT © [Tyler Robertson](https://github.com/TylerNRobertson) @ [Pixel Perfect Software Inc.](https://github.com/pixel-perfect-software) - See [LICENSE](LICENSE) for details.
