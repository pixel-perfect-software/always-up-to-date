# Installation Guide

## Global Installation (Recommended)

```bash
npm install -g always-up-to-date
```

## One-time Usage

```bash
npx always-up-to-date check
```

## Verify Installation

```bash
alwaysuptodate --version
```

## Prerequisites

- Node.js 16 or higher
- npm, yarn, pnpm, or bun package manager
- Git (for GitHub integration features)

## Troubleshooting

### Permission Issues

If you encounter permission issues during global installation:

```bash
# Use npm's built-in permission fix
npm config set prefix ~/.npm-global
export PATH=~/.npm-global/bin:$PATH
```

### Package Manager Detection

The tool automatically detects your package manager based on lock files:

- `package-lock.json` → npm
- `yarn.lock` → yarn
- `pnpm-lock.yaml` → pnpm
- `bun.lockb` → bun

You can override detection with the `--packageManager` flag.

## Need Help?

If you encounter installation issues, check out our **[Troubleshooting Guide](./troubleshooting.md)** for common solutions.

## Next Steps

- **[Quick Start Guide](./quick-start.md)** - Get up and running in minutes
- **[Commands Reference](./commands.md)** - Learn about available commands
