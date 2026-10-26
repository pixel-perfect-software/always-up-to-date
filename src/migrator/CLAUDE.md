# Migrator - Component Context

## Purpose
Framework-specific migration rules for major version upgrades. Provides codemod-like transformations for breaking changes.

## Current Status: In Development (Stub)
`PackageMigrator` class exists with an empty `migratePackage()` method. Example rule files exist but are not wired up.

## Major Subsystem Organization
```
migrator/
  index.ts                    # Stub PackageMigrator class
  rules/
    react/react18.ts          # React 18 migration rules (example)
    react/react19.ts          # React 19 migration rules (example)
    next/next14.ts            # Next.js 14 migration rules (example)
    next/next15.ts            # Next.js 15 migration rules (example)
```

## Integration Points
- Will integrate with `src/managers/` update flow to apply codemods after version bumps
- Use Node's built-in `fs.glob` / `fsPromises.glob` for file discovery during codemod application (no `glob` package needed — project requires Node ^22.23.0 || >=24.17.0; `fs.glob` is stable only from Node 24, so check it on 22 before relying on it)
