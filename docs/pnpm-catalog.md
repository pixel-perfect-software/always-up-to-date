# pnpm Catalog Support

Always Up To Date now supports pnpm's catalog feature, which allows you to define centralized dependency versions in your monorepo.

## What is pnpm Catalog?

The pnpm catalog feature allows you to define a centralized catalog of dependency versions in your `pnpm-workspace.yaml` file. Packages in your workspace can then reference these catalog versions instead of specifying versions directly.

## How it Works

### 1. Define Your Catalog

In your `pnpm-workspace.yaml`:

```yaml
packages:
  - "packages/*"
  - "apps/*"

catalog:
  react: ^18.2.0
  typescript: ^5.3.0
  "@types/node": ^20.0.0
  "@types/react": ^18.2.0
  eslint: ^8.50.0
  prettier: ^3.0.0
```

### 2. Reference Catalog Versions

In your package.json files:

```json
{
  "dependencies": {
    "react": "catalog:"
  },
  "devDependencies": {
    "typescript": "catalog:",
    "@types/react": "catalog:"
  }
}
```

## Auto-Detection and Priority Resolution

Always Up To Date automatically detects and handles mixed usage of catalog references and direct versions using a priority system:

### Priority Order (Highest to Lowest):

1. **Direct specific version** (e.g., `"react": "18.2.0"`)
2. **Direct version range** (e.g., `"react": "^18.0.0"`)
3. **Catalog reference** (e.g., `"react": "catalog:"`)

### Examples:

#### Example 1: All Catalog References

If all packages use catalog references for a dependency, the catalog will be updated:

```yaml
# pnpm-workspace.yaml
catalog:
  react: ^18.2.0 # This will be updated to ^18.3.0
```

#### Example 2: Mixed Usage with Direct Version

If some packages use direct versions, the highest priority version determines the update:

```json
// Package A
"react": "catalog:"  // Resolves to ^18.2.0 from catalog

// Package B
"react": "18.3.0"    // Direct version - HIGHEST PRIORITY
```

In this case, Package B's direct version will be updated, and the catalog remains unchanged.

## Update Behavior

When running `always-up-to-date`, the tool will:

1. **Detect catalog usage** automatically
2. **Resolve versions** based on the priority system
3. **Update the appropriate location**:
   - If highest priority is catalog → Update `pnpm-workspace.yaml`
   - If highest priority is direct → Update the specific `package.json`
4. **Run `pnpm install`** automatically after catalog updates

## Benefits

1. **Centralized Version Management**: Update once in the catalog, all packages using catalog references get the update
2. **Reduced Conflicts**: Fewer version conflicts across your monorepo
3. **Flexibility**: Mix catalog references with direct versions when needed
4. **Automatic Handling**: No configuration needed - just works out of the box

## Migration Tips

If you're migrating an existing pnpm monorepo to use catalogs:

1. Identify common dependencies across packages
2. Add them to the catalog in `pnpm-workspace.yaml`
3. Update package.json files to use `"catalog:"` references
4. Run `pnpm install` to apply changes

Always Up To Date will respect your choices and handle both catalog and direct dependencies appropriately during updates.
