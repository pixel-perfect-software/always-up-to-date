# Utilities - Component Context

## Purpose
Shared utilities for configuration management, update logic, registry/cooldown handling, logging, file operations, and package grouping.

## Current Status: Stable
Core utilities fully implemented. Central barrel export via `index.ts`.

## Component-Specific Development Guidelines
- All exports consolidated through `src/utils/index.ts` barrel file
- `execAsync` (promisified `exec`) is re-exported here for use by `CommandRunner`
- Config uses nullish coalescing with `DEFAULT_CONFIG` for safe merging
- Network/IO utilities (registry, npmrcLoader) must fail open — never block updates on a transient error

## Major Subsystem Organization
```
utils/
  index.ts            # Barrel: re-exports execAsync, config, cooldown, duration, logger, filterPackages, npmrcLoader, packageGrouper, registry, updateChecker, files
  config.ts           # loadConfig(), saveJsonConfig(), DEFAULT_CONFIG (now includes cooldown)
  cooldown.ts         # normalizeCooldown(), isCooldownEnabled(), cooldownDaysFor(), evaluateCooldown()
  duration.ts         # parseDuration() (number | '1 week' | '24h' → days), formatAgeDays(), MS_PER_DAY
  npmrcLoader.ts      # loadRegistryConfig() reads .npmrc + ~/.npmrc + NPM_CONFIG_* env, returns RegistryConfig
  registry.ts         # fetchReleaseTimes() wraps npm-registry-fetch with in-memory per-run cache
  updateChecker.ts    # Semver-based update filtering (single package, sync)
  filterPackages.ts   # Async batch filtering with cooldown gating, returns UpdateResult[]
  packageGrouper.ts   # Groups packages by @scope for display
  logger.ts           # Colored logging (colorette)
  files.ts            # checkIfFileExists(), updatePackageJson(), updatePNPMWorkspaceYAML(), updateBunCatalogs(), identifyCatalogPackages()
```

## Architectural Patterns

### Configuration (`config.ts`)
- Config file: `.always-up-to-date.json` in project root
- `loadConfig(workingDir?)` reads JSON, merges with `DEFAULT_CONFIG`
- `saveJsonConfig(config, filePath)` writes formatted JSON
- Schema: `AlwaysUpToDateConfig` (see `src/types.ts`)
- `cooldown` accepts: number (days), duration string (`'1 week'`, `'24h'`), or per-update-type object `{ patch, minor, major }` whose values are themselves numbers or duration strings

### Update Logic (`updateChecker.ts`)
Priority order:
1. Invalid semver -> reject
2. In `updateAllowlist` -> always allow
3. In `updateDenylist` -> always reject
4. No version diff -> reject
5. By type: `patch` always allowed, `minor` if `allowMinorUpdates`, `major` if `allowMajorUpdates`
6. `allowMajorUpdates: true` implicitly enables minor updates

### Cooldown (`cooldown.ts` + `duration.ts`)
- `cooldown.ts` is gate logic: normalize the user's config to `{ patch, minor, major }` days, decide if a release is too fresh given its update type and timestamp
- `duration.ts` is the generic time/format layer: `parseDuration` accepts numbers, bare numeric strings, and `<n><unit>` (s/min/h/d/w/mo/y) — fails to 0 so callers can fail open
- `evaluateCooldown` returns `{ gated, ageDays, requiredDays }` — gating is a soft signal, callers decide what to do
- Cooldown gating only runs after semver eligibility — packages already rejected by `updateChecker` never trigger network calls

### Registry / .npmrc (`registry.ts` + `npmrcLoader.ts`)
- `loadRegistryConfig(cwd)` parses `.npmrc` (cwd → ~/.npmrc → `NPM_CONFIG_*` env, highest wins) into `RegistryConfig`. Substitutes `${VAR}` env references. Recognizes registry, scoped registries, auth tokens, always-auth, strict-ssl, ca/cafile.
- `fetchReleaseTimes(name, registryConfig)` calls `npm-registry-fetch` with `fullMetadata: true` (corgi format strips `time`), maps the result to `Record<version, ISO>`. Network failure → empty map (cached) so the cooldown gate fails open.
- One in-memory cache per CLI run; `clearRegistryCache()` is exported for tests.
- Limitation: yarn berry's `.yarnrc.yml` and bun's `bunfig.toml` are not read in v1. Common case (npm-spec `.npmrc`) covers all four PMs.

### Package Grouping (`packageGrouper.ts`)
Groups packages by `@scope/` prefix. Unscoped packages go to a default group. Groups sorted alphabetically.

### Package Filtering (`filterPackages.ts`)
- Async. Signature: `filterPackages(outdated, { targetPackages?, cwd?, now? })`
- Wraps `updateChecker` for batch operations across all outdated packages
- When cooldown is enabled (`cooldown > 0` for any update type), fetches release times from the registry for semver-eligible packages and applies the gate
- Returns `UpdateResult[]` with name, current, latest, updateType, updated (boolean), reason, and optional `releaseAge`
- Used by all manager `updatePackages()` methods, dry-run, and interactive mode

## Integration Points
- `src/commandRunner.ts` uses `execAsync` and `logger`
- `src/managers/*/index.ts` use `filterPackages`, `logger`, `groupAndSortPackages`, `updatePackageJson`
- `src/commands/update.ts` uses `filterPackages` for dry-run and interactive mode
- `src/commands/init.ts` uses `saveJsonConfig` and `DEFAULT_CONFIG`
