# Utilities - Component Context

## Purpose
Shared utilities for configuration management, update logic, registry/cooldown handling, logging, file operations, and package grouping.

## Current Status: Stable
Core utilities fully implemented. Central barrel export via `index.ts`.

## Component-Specific Development Guidelines
- All exports consolidated through `src/utils/index.ts` barrel file
- `runProcess(file, args, { cwd })` is the only way to start a subprocess: `execFile` with no shell and `maxBuffer: Infinity`. On Windows, where npm/pnpm/yarn are `.cmd` shims Node only starts through cmd.exe, it runs `buildWindowsCommand()` through the shell, double-quoting arguments that contain cmd.exe operators (Windows path not covered by CI)
- `runProcess` passes `env: process.env` explicitly; under Jest the sandbox env otherwise never reaches the child, so PATH-shim tests depend on it
- Config uses nullish coalescing with `DEFAULT_CONFIG` for safe merging
- Network/IO utilities (registry, npmrcLoader) must fail open — never block updates on a transient error

## Major Subsystem Organization
```
utils/
  index.ts            # Barrel: re-exports runProcess, config, cooldown, duration, logger, filterPackages, npmrcLoader, packageGrouper, registry, updateChecker, files
  runProcess.ts       # runProcess() (execFile + args, no output cap), buildWindowsCommand()
  config.ts           # loadConfig(), saveJsonConfig(), DEFAULT_CONFIG, INITIAL_CONFIG, ConfigError
  cooldown.ts         # normalizeCooldown(), isCooldownEnabled(), cooldownDaysFor(), evaluateCooldown()
  duration.ts         # parseDuration() (number | '1 week' | '24h' → days), formatAgeDays(), MS_PER_DAY
  npmrcLoader.ts      # loadRegistryConfig() reads .npmrc + ~/.npmrc + NPM_CONFIG_* env, returns RegistryConfig
  registry.ts         # fetchReleaseTimes() wraps npm-registry-fetch with in-memory per-run cache
  updateChecker.ts    # Update policy: within range by default, beyondRange level, per-package rules (pure)
  rows.ts             # toOutdatedRow() / toUpdatingRow(): display rows (in-range note, beyond-range flag)
  overrides.ts        # findControllingOverrides(cwd, pm): packages an override pins, with field and range
  peers.ts            # readInstalledPeers(cwd): installed peer ranges by constrained package (node_modules, pnpm store)
  filterPackages.ts   # Async batch filtering with cooldown gating, returns UpdateResult[]
  packageGrouper.ts   # Groups packages by @scope for display
  logger.ts           # Colored logging (colorette); setQuiet() silences all, setJsonOutput() drops progress and sends errors/warnings/debug to stderr
  files.ts            # checkIfFileExists(), updatePackageJson(), updatePNPMWorkspaceYAML(), updateBunCatalogs(), identifyCatalogPackages(), buildUpdateDescriptors()
```

## Architectural Patterns

### Configuration (`config.ts`)
- Config file: `.always-up-to-date.json` in project root
- `loadConfig(workingDir?)` reads JSON, merges with `DEFAULT_CONFIG`
- `saveJsonConfig(config, filePath)` writes formatted JSON; `autd init` writes `INITIAL_CONFIG` (`beyondRange`, `rules`, `cooldown`, `debug`, `silent`), never the deprecated fields
- Schema: `AlwaysUpToDateConfig` (see `src/types.ts`); `ConfigFile` is any subset of it plus `$schema`
- `beyondRange` and `rules` are validated strictly: an unknown level or rule throws instead of being ignored (ignoring `"react": "hodl"` would update a package meant to be held). `beyondRange` stays `undefined` when absent so the deprecated fields can still decide
- Every load failure (malformed JSON, invalid value) is a `ConfigError`. The logger loads config on import, so it surfaces while the CLI is being imported; `src/index.ts` imports the CLI inside its `try` and prints it as one `autd: …` line, exit 1
- `cooldown` accepts: number (days), duration string (`'1 week'`, `'24h'`), or per-update-type object `{ patch, minor, major }` whose values are themselves numbers or duration strings

### Update Policy (`updateChecker.ts`)
`updateChecker(info, policy)` is pure: it returns `{ target }` (where the package moves) or `{ reason }` (why it is held). `filterPackages` builds the policy per run with `policyFromConfig(loadConfig(cwd))`.
1. Invalid semver: held (`invalid version …`)
2. Rule `hold`: held. Rule `latest`: target `latest`, any step size
3. Default: stay within the manifest range. Target is `wanted` (the highest version the range allows) when it is ahead of `current`; an exact pin has `wanted == current`, so it is held (`patch beyond the range`, etc.)
4. `beyondRange` (`none` | `patch` | `minor` | `major`) lets a package move past its range to `latest` when the step `current → latest` is at most that size. It applies to exact pins too. Rule `followRange` opts a package out
- `policyFromConfig()`: `beyondRange` if set, else the deprecated `allowMajorUpdates` → `major` / `allowMinorUpdates` → `minor` / `none`. `ruleFor(name)`: exact key in `rules`, then the longest matching `*` glob, then the deprecated lists (`updateAllowlist` → `latest`, `updateDenylist` → `hold`). `*` is the only wildcard
- `stepLevel()` folds pre-release diffs into patch/minor/major

### Cooldown (`cooldown.ts` + `duration.ts`)
- `cooldown.ts` is gate logic: normalize the user's config to `{ patch, minor, major }` days, decide if a release is too fresh given its update type and timestamp
- `duration.ts` is the generic time/format layer: `parseDuration` accepts numbers, bare numeric strings, and `<n><unit>` (s/min/h/d/w/mo/y) — fails to 0 so callers can fail open
- `evaluateCooldown` returns `{ gated, ageDays, requiredDays }` — gating is a soft signal, callers decide what to do
- Cooldown gating judges the chosen `target` version, not `latest`, and only runs for packages with a target, so held packages never trigger network calls

### Registry / .npmrc (`registry.ts` + `npmrcLoader.ts`)
- `loadRegistryConfig(cwd)` parses `.npmrc` (cwd → ~/.npmrc → `NPM_CONFIG_*` env, highest wins) into `RegistryConfig`. Substitutes `${VAR}` env references. Recognizes registry, scoped registries, auth tokens, always-auth, strict-ssl, ca/cafile.
- `fetchReleaseTimes(name, registryConfig)` calls `npm-registry-fetch` with `fullMetadata: true` (corgi format strips `time`), maps the result to `Record<version, ISO>`. Network failure → empty map (cached) so the cooldown gate fails open.
- One in-memory cache per CLI run; `clearRegistryCache()` is exported for tests.
- Limitation: yarn berry's `.yarnrc.yml` and bun's `bunfig.toml` are not read in v1. Common case (npm-spec `.npmrc`) covers all four PMs.

### Manifest Specs (`files.ts`)
- Every writer builds the new spec with `nextVersionSpec()`, which keeps the decorator the current spec has. An exact pin stays exact; a decorator is never added
- `catalog:` and `workspace:` references are never rewritten
- `buildUpdateDescriptors()` applies the same rule to produce `name@spec` for managers that write the manifest themselves (yarn), reading `dependencies`, then `devDependencies`, then `optionalDependencies`

### Package Grouping (`packageGrouper.ts`)
Groups packages by `@scope/` prefix. Unscoped packages go to a default group. Groups sorted alphabetically.

### Package Filtering (`filterPackages.ts`)
- Async. Signature: `filterPackages(outdated, { targetPackages?, cwd?, now? })`
- Runs `updateChecker` on every outdated package with the policy for `cwd`
- When cooldown is enabled (`cooldown > 0` for any update type), fetches release times from the registry for packages with a target and applies the gate
- Returns `UpdateResult[]` with name, current, wanted, latest, `target` (when updated), updateType (`current → target`, else `current → latest`), updated, reason, and optional `releaseAge`
- With `packageManager`, a target outside the range of an override that manager enforces is held (`controlled by <field> (<range>)`), whatever the rules say; a held package names the override when `latest` is outside it too. Fields, as the current manager versions read them (verified by real installs): npm `overrides`; yarn berry `resolutions` (yarn v1 does not apply them to a direct dependency, so nothing is held); pnpm `overrides` in pnpm-workspace.yaml (pnpm 12 ignores `pnpm.overrides` / `resolutions` in package.json); bun `overrides` and `resolutions`. `$name` references and keys that only reach another package's dependencies (`a>b`, `a/b`, objects without `.`) don't pin
- Peer pass (`holdPeerConflicts`), when anything has a target: a target an installed package's peer range excludes is held (`peer conflict: <pkg>@<ver> needs <name> <range>`). Ranges from packages also moving in the run don't count (their new peers are unknown offline). Repeats until stable, since a hold can expose another conflict. A `latest` rule still moves, with `warning` set. Runs before cooldown, so held packages cost no network. ~22 ms for ~600 installed packages
- `splitUpdates(results)` divides the chosen updates into `withinRange` names (target == wanted: hand to the manager, write nothing) and `beyondRange` name → version (write the manifest spec first)
- Used by all manager `updatePackages()` methods, dry-run, and interactive mode

## Integration Points
- `src/commandRunner.ts` uses `runProcess` and `logger`
- `src/managers/*/index.ts` use `filterPackages`, `logger`, `groupAndSortPackages`, `updatePackageJson`
- `src/commands/update.ts` uses `filterPackages` for dry-run and interactive mode
- `src/commands/init.ts` uses `saveJsonConfig` and `INITIAL_CONFIG`
