# PR Generator - Component Context

## Purpose
Automated pull request creation with migration guides and changelogs for dependency updates.

## Current Status: In Development (Stub)
`PRGenerator` class exists with empty `generatePRTitle()` and `generatePRDescription()` methods.

## Major Subsystem Organization
```
prGenerator/
  index.ts    # Stub PRGenerator class
```

## Integration Points
- Will consume output from `src/migrator/` for migration-aware PR descriptions
- For GitHub API integration, install the unified `octokit` package when this feature is built (preferred over the older `@octokit/rest` — slimmer, bundles throttling/retry plugins)
- Use Node's built-in `fetch` for any non-GitHub HTTP calls — no need for `axios` (project requires Node >=24.0.0, where `fetch` is stable)
