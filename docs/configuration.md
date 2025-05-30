# Configuration Guide

## Configuration File

Create `.alwaysuptodate.json` in your project root for advanced customization:

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

## Configuration Options

### Global Settings

#### `autoUpdate` (boolean)

- **Default**: `false`
- **Description**: Enable automatic updates without prompts
- **Example**: `"autoUpdate": true`

#### `createPRs` (boolean)

- **Default**: `false`
- **Description**: Automatically create GitHub PRs for updates
- **Example**: `"createPRs": true`

#### `updateStrategy` (string)

- **Default**: `"minor"`
- **Options**: `"major"`, `"minor"`, `"patch"`
- **Description**: Default update strategy for all packages
- **Example**: `"updateStrategy": "patch"`

#### `includeDev` (boolean)

- **Default**: `true`
- **Description**: Include devDependencies in updates
- **Example**: `"includeDev": false`

#### `onlyDirect` (boolean)

- **Default**: `false`
- **Description**: Only update direct dependencies (not transitive)
- **Example**: `"onlyDirect": true`

### Package Management

#### `ignoredPackages` (string[])

- **Default**: `[]`
- **Description**: Packages to skip during updates
- **Example**: `["@types/node", "typescript", "react"]`

#### `packageRules` (object[])

Package-specific rules that override global settings. Each rule can contain:

- `name` (string) - Package name or pattern (supports glob patterns)
- `updateStrategy` (string) - Override global update strategy
- `autoUpdate` (boolean) - Override global auto-update setting
- `ignoredVersions` (string[]) - Specific versions to skip
- `maxVersion` (string) - Maximum version to update to
- `minVersion` (string) - Minimum version requirement

**Examples**:

```json
{
  "packageRules": [
    {
      "name": "react",
      "updateStrategy": "minor",
      "autoUpdate": false,
      "maxVersion": "18.9.9"
    },
    {
      "name": "@types/*",
      "updateStrategy": "patch",
      "autoUpdate": true
    },
    {
      "name": "eslint",
      "ignoredVersions": ["9.0.0-beta.1", "9.0.0-beta.2"]
    }
  ]
}
```

### GitHub Integration

#### `baseBranch` (string)

- **Default**: `"main"`
- **Description**: Base branch for creating PRs
- **Example**: `"baseBranch": "develop"`

#### `batchSize` (number)

- **Default**: `10`
- **Description**: Number of packages to update per batch/PR
- **Example**: `"batchSize": 5`

#### `createSeparatePRs` (boolean)

- **Default**: `false`
- **Description**: Create separate PRs for each major version update
- **Example**: `"createSeparatePRs": true`

#### `parallelUpdates` (boolean)

- **Default**: `false`
- **Description**: Enable parallel processing of updates
- **Example**: `"parallelUpdates": true`

### Safety & Confirmation

#### `confirmBeforeUpdate` (boolean)

- **Default**: `true`
- **Description**: Require confirmation before applying updates
- **Example**: `"confirmBeforeUpdate": false`

## Environment Variables

You can also configure Always Up To Date using environment variables:

```bash
# GitHub token for PR creation
export GITHUB_TOKEN="your_token_here"

# Default update strategy
export ALWAYSUPTODATE_UPDATE_STRATEGY="minor"

# Batch size for updates
export ALWAYSUPTODATE_BATCH_SIZE=5

# Auto-update mode
export ALWAYSUPTODATE_AUTO_UPDATE=true
```

## Example Configurations

### Conservative Updates

```json
{
  "updateStrategy": "patch",
  "autoUpdate": false,
  "confirmBeforeUpdate": true,
  "createSeparatePRs": true,
  "packageRules": [
    {
      "name": "react",
      "updateStrategy": "minor",
      "autoUpdate": false
    },
    {
      "name": "@types/*",
      "updateStrategy": "minor"
    }
  ]
}
```

### Aggressive Updates

```json
{
  "updateStrategy": "major",
  "autoUpdate": true,
  "confirmBeforeUpdate": false,
  "parallelUpdates": true,
  "batchSize": 20,
  "packageRules": [
    {
      "name": "*",
      "autoUpdate": true
    }
  ]
}
```

### Production-Safe

```json
{
  "updateStrategy": "minor",
  "ignoredPackages": ["react", "next", "@types/node"],
  "includeDev": true,
  "onlyDirect": true,
  "confirmBeforeUpdate": true,
  "packageRules": [
    {
      "name": "@types/*",
      "updateStrategy": "patch",
      "autoUpdate": true
    },
    {
      "name": "eslint*",
      "updateStrategy": "patch"
    }
  ]
}
```

## Priority Order

Configuration is resolved in the following order (highest to lowest priority):

1. Command line flags
2. Environment variables
3. `.alwaysuptodate.json` in project root
4. Default values

## Validation

The configuration file is validated when loaded. Common errors:

- Invalid `updateStrategy` values
- Invalid package patterns in `packageRules`
- Missing required fields
- Type mismatches

Use `npx alwaysuptodate init` to generate a valid configuration file template.
