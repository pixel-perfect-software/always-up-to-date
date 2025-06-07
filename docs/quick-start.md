# Quick Start Guide

Get up and running with Always Up To Date in minutes.

## Installation

```bash
# Global installation (recommended)
npm install -g @pixel-perfect-software/always-up-to-date

# Or use directly with npx
npx @pixel-perfect-software/always-up-to-date --help
```

## Basic Commands

### Check for Outdated Dependencies

```bash
# Check what packages can be updated
autd check
```

This command will:

- Automatically detect your package manager (npm, yarn, pnpm, bun)
- Check for workspace configurations
- Show you all outdated dependencies

### Update Dependencies

```bash
# Update all outdated dependencies
autd update
```

This command will:

- Check for outdated packages first
- Update packages that are safe to upgrade
- Respect workspace configurations for monorepos

### Get Help

```bash
# Show available commands
autd help
```

## Your First Update

1. **Navigate to your project**:

   ```bash
   cd your-project-directory
   ```

2. **Check what's outdated**:

   ```bash
   autd check
   ```

3. **Review the output** to see which packages can be updated

4. **Update the packages**:

   ```bash
   autd update
   ```

5. **Test your application** after updates to ensure everything works correctly

## Package Manager Detection

The tool automatically works with:

- **npm projects** - Detects `package-lock.json`
- **Yarn projects** - Detects `yarn.lock`
- **pnpm projects** - Detects `pnpm-lock.yaml`
- **Bun projects** - Detects `bun.lock`

## Workspace Support

Works seamlessly with monorepos and workspaces:

- **npm workspaces** - Automatically detected from `package.json`
- **Yarn workspaces** - Full support for workspace configurations
- **pnpm workspaces** - Supports pnpm workspace setups
- **Bun workspaces** - Supports bun workspace configurations

## Examples

### Single Package Project

```bash
cd my-react-app
autd check
autd update
```

### Monorepo/Workspace Project

```bash
cd my-monorepo
autd check    # Checks all workspaces
autd update   # Updates across all workspaces
```

## Coming Soon

### Migration Support

```bash
# Apply smart migration rules (in development)
autd migrate
```

This will provide:

- Automated migration rules for popular packages
- Breaking change guidance
- Code transformation assistance

## Next Steps

- **[Commands Reference](./commands.md)** - Detailed command documentation
- **[Installation Guide](./installation.md)** - Advanced installation options
- **[Contributing](./contributing.md)** - How to contribute to the project

## Need Help?

- **[Troubleshooting Guide](./troubleshooting.md)** - Common issues and solutions
- **[GitHub Issues](https://github.com/pixel-perfect-software/always-up-to-date/issues)** - Report bugs or request features
