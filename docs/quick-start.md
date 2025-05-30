# Quick Start Guide

## Basic Commands

### Check for Outdated Dependencies

```bash
# Simple check
npx alwaysuptodate check

# With preview details
npx alwaysuptodate check --preview

# Interactive mode
npx alwaysuptodate check --interactive
```

### Security Audit

```bash
# Basic audit
npx alwaysuptodate audit

# With detailed output
npx alwaysuptodate audit --verbose
```

### Auto-update Dependencies

```bash
# Simple auto-update
npx alwaysuptodate auto

# With GitHub PR creation
npx alwaysuptodate auto --createIssue

# Dry run to preview changes
npx alwaysuptodate auto --dry-run
```

## Your First Update

1. **Check what's outdated**:

   ```bash
   npx alwaysuptodate check --preview
   ```

2. **Review the changes** in the detailed output

3. **Apply updates interactively**:

   ```bash
   npx alwaysuptodate check --interactive
   ```

4. **Test your application** after updates

5. **Rollback if needed**:
   ```bash
   npx alwaysuptodate rollback
   ```

## Safety First

Always Up To Date includes several safety features:

- **Automatic Backups**: Creates `package.json.backup` before changes
- **Smart Rollback**: Easy undo with `rollback` command
- **Preview Mode**: See changes before applying
- **Interactive Selection**: Choose exactly which packages to update

## Next Steps

- Set up [GitHub Integration](./github-integration.md) for automated PRs
- Configure [Update Rules](./configuration.md) for your project
- Learn about [Advanced Usage](./commands.md) patterns
- Check [Safety Features](./safety-features.md) for backup and rollback options

## Need Help?

- **[Troubleshooting Guide](./troubleshooting.md)** - Common issues and solutions
- **[Full Documentation](./README.md)** - Complete documentation index
