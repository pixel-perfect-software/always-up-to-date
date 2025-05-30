# Safety Features

Always Up To Date prioritizes safety with multiple built-in protection mechanisms.

## Automatic Backups

### How It Works

Before making any changes to your `package.json`, Always Up To Date automatically creates a backup:

```bash
# Original file is preserved
package.json.backup
```

### Backup Location

- **Default**: Same directory as `package.json`
- **Naming**: `package.json.backup`
- **Timestamp**: Backup includes modification timestamp

### Manual Backup

You can also create manual backups:

```bash
npx alwaysuptodate check --dry-run  # Preview without backup
cp package.json package.json.manual-backup  # Manual backup
```

## Smart Rollback

### Quick Rollback

Easily undo any changes:

```bash
npx alwaysuptodate rollback
```

### What Gets Restored

- `package.json` content
- `package-lock.json` (if exists)
- Dependency versions
- Scripts and metadata

### Rollback Options

```bash
# Keep backup file after rollback
npx alwaysuptodate rollback --keep-backup

# Use custom backup file
npx alwaysuptodate rollback --backup-file ./my-backup.json
```

## Breaking Change Detection

### Major Version Updates

The tool identifies potentially breaking changes:

- **Major version bumps** (1.x.x → 2.x.x)
- **Pre-release versions** (beta, alpha, rc)
- **Known breaking packages** (React 17→18, Next.js 13→14)

### Breaking Change Warnings

When major updates are detected:

```
⚠️  Breaking Changes Detected:
  react: 17.0.2 → 18.2.0 (Major update - review breaking changes)
  next: 13.5.1 → 14.0.0 (Major update - review migration guide)
```

### Interactive Review

Use interactive mode to review each breaking change:

```bash
npx alwaysuptodate check --interactive
```

## Vulnerability Scanning

### Built-in Security Audit

Always Up To Date integrates with npm's security audit:

```bash
# Check for vulnerabilities
npx alwaysuptodate audit

# Fix vulnerabilities automatically
npx alwaysuptodate audit --fix
```

### Vulnerability Prioritization

Updates prioritize security fixes:

1. **Critical vulnerabilities** - Updated first
2. **High severity** - High priority
3. **Moderate/Low** - Normal priority
4. **Informational** - Lowest priority

### Security Reports

Detailed vulnerability reports include:

- **Severity level** (Critical, High, Moderate, Low)
- **Affected versions**
- **Fix recommendations**
- **CVE identifiers**

## Migration Advisor

### Supported Packages

Detailed migration guides for popular packages:

- **React** (17→18, etc.)
- **Next.js** (13→14, etc.)
- **TypeScript** (4→5, etc.)
- **ESLint** (8→9, etc.)
- **Jest** (28→29, etc.)
- **Prettier** (2→3, etc.)

### Migration Instructions

When updating supported packages, get detailed guidance:

```
📚 Migration Guide: React 17 → 18

  Breaking Changes:
  • Automatic batching behavior changed
  • New JSX transform required
  • StrictMode effects run twice in development

  Required Actions:
  1. Update React types: npm install @types/react@^18
  2. Review component lifecycle methods
  3. Test Suspense and concurrent features

  Learn more: https://react.dev/blog/2022/03/29/react-v18
```

### Custom Migration Rules

Add your own migration rules in configuration:

```json
{
  "packageRules": [
    {
      "name": "my-package",
      "migrationGuide": "https://docs.my-package.com/migration"
    }
  ]
}
```

## Preview Mode

### Dry Run

See exactly what would change before applying:

```bash
npx alwaysuptodate check --preview
npx alwaysuptodate auto --dry-run
```

### Detailed Output

Preview mode shows:

- **Current versions**
- **Target versions**
- **Change type** (patch, minor, major)
- **Breaking change warnings**
- **Security vulnerability fixes**

### Example Preview

```
📦 Package Updates Preview:

┌─────────────────┬─────────┬─────────┬──────────┬─────────────────┐
│ Package         │ Current │ Latest  │ Type     │ Notes           │
├─────────────────┼─────────┼─────────┼──────────┼─────────────────┤
│ lodash          │ 4.17.20 │ 4.17.21 │ patch    │ Security fix    │
│ react           │ 17.0.2  │ 18.2.0  │ major    │ ⚠️  Breaking    │
│ @types/node     │ 16.11.7 │ 20.8.0  │ major    │ Types update    │
└─────────────────┴─────────┴─────────┴──────────┴─────────────────┘
```

## Interactive Selection

### Granular Control

Choose exactly which packages to update:

```bash
npx alwaysuptodate check --interactive
```

### Interactive Interface

```
? Select packages to update:
  ◯ lodash (4.17.20 → 4.17.21) - Security fix
  ◯ react (17.0.2 → 18.2.0) - ⚠️  Breaking changes
  ◉ @types/node (16.11.7 → 20.8.0) - Types update
  ◯ prettier (2.8.1 → 3.0.0) - ⚠️  Breaking changes
```

### Batch Selection

Select all, none, or by criteria:

- **All patches** - Only safe updates
- **All minor** - Feature updates without breaking changes
- **Security fixes** - Only vulnerability patches
- **Custom selection** - Pick specific packages

## Package Manager Detection

### Automatic Detection

The tool automatically detects your package manager:

- `package-lock.json` → **npm**
- `yarn.lock` → **yarn**
- `pnpm-lock.yaml` → **pnpm**
- `bun.lockb` → **bun**

### Lock File Preservation

Maintains compatibility with your package manager:

- **npm**: Updates `package-lock.json`
- **yarn**: Updates `yarn.lock`
- **pnpm**: Updates `pnpm-lock.yaml`
- **bun**: Updates `bun.lockb`

### Override Detection

Force a specific package manager:

```bash
npx alwaysuptodate check --package-manager yarn
```

## Error Handling

### Graceful Failures

If updates fail:

1. **Automatic rollback** to previous state
2. **Detailed error reporting**
3. **Preservation of backup files**
4. **Partial update recovery**

### Common Error Scenarios

- **Network failures** - Retry with exponential backoff
- **Version conflicts** - Skip problematic packages
- **Permission issues** - Clear error messages
- **Invalid configurations** - Validation with suggestions

### Recovery Options

```bash
# Force rollback if auto-rollback fails
npx alwaysuptodate rollback --force

# Verify package.json integrity
npm ls --depth=0

# Reinstall dependencies
rm -rf node_modules package-lock.json
npm install
```
