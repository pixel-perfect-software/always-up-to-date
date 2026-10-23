# Utilities - Component Context

## Purpose
Shared utilities for configuration management, update logic, registry/cooldown handling, logging, file operations, and package grouping.

## Current Status: Stable
Core utilities fully implemented. Central barrel export via `index.ts`.

## Component-Specific Development Guidelines
- All exports consolidated through `src/utils/index.ts` barrel file
- `runProcess(file, args, { cwd })` is the only way to start a subprocess: `execFile` with no shell and `maxBuffer: Infinity`. On Windows, where npm/pnpm/yarn are `.cmd` shims Node only starts through cmd.exe, it runs `buildWindowsCommand()` through the shell, double-quoting arguments that contain cmd.exe operators (the windows-latest CI jobs cover it: the `.cmd` shim test in runProcess.test.ts, realSubprocess.test.ts through `npm.cmd`, and the integration matrix against real npm, pnpm, yarn and bun on Windows)
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
  rows.ts             # toOutdatedRow() / toOutdatedRows() / toUpdatingRow(): display rows (in-range note, beyond-range flag; one outdated row per manifest in a workspace)
  overrides.ts        # overridesFromField(), manifestOverrides(cwd, fields): packages an override pins, with field and range
  peers.ts            # readInstalledPeers(cwd): installed peer ranges by constrained package (node_modules, pnpm store)
  saveStyle.ts        # SaveStyle, DEFAULT_SAVE_STYLE, readTextFile(), yamlValue(): what adapters' saveStyle() builds on
  manifestNames.ts    # toManifestNames(cwd, outdated), toEntryManifestNames(cwd, entries): re-key a report by package.json names (npm: aliases), per owning manifest in a workspace
  workspaceRows.ts    # foldWorkspaceEntries(entries): one PackageInfo per name with `workspaces`; expandWorkspaces(record): the inverse, one row per manifest; workspaceLabel(path): `(root)` or the path
  installed.ts        # readInstalledVersions(cwd, rows): each moving row's installed version (the pipeline uses an adapter's own `installed()` instead when it has one: yarn berry, PnP), keyed by `rowKey` (the name, plus `<workspace>:` in a workspace project), read from `<member>/node_modules/<name>` first, then the root's, only for names that manifest declares; checkApplied(): rows the manager left in place become `not applied by <pm> (installed …)`
  filterPackages.ts   # Async batch filtering with cooldown gating, returns UpdateResult[]
  packageGrouper.ts   # Groups packages by @scope for display
  logger.ts           # Colored logging (colorette); configure(config) takes `debug`, `silent` and the deprecated allow/deny lists (defaults before it: debug off, not quiet, no lists), setQuiet() silences all, setJsonOutput() drops progress and sends errors/warnings/debug to stderr
  files.ts            # checkIfFileExists(), updatePackageJson(), updatePNPMWorkspaceYAML(), updateBunCatalogs(), readSpec(), splitCatalogUpdates(), buildUpdateDescriptors()
```

## Architectural Patterns

### Configuration (`config.ts`)
- Config file: `.always-up-to-date.json` in project root
- `loadConfig(workingDir?)` reads JSON, merges with `DEFAULT_CONFIG`. Only `openProject` (`src/project.ts`) calls it for a command run; everything else takes the loaded config as a parameter
- `saveJsonConfig(config, filePath)` writes formatted JSON; `autd init` writes `INITIAL_CONFIG` (`beyondRange`, `rules`, `cooldown`, `debug`, `silent`), never the deprecated fields
- Schema: `AlwaysUpToDateConfig` (see `src/types.ts`); `ConfigFile` is any subset of it plus `$schema`
- `beyondRange` and `rules` are validated strictly: an unknown level or rule throws instead of being ignored (ignoring `"react": "hodl"` would update a package meant to be held). `beyondRange` stays `undefined` when absent so the deprecated fields can still decide
- Every load failure (malformed JSON, invalid value) is a `ConfigError`. `openProject` throws it inside the command's `try`, so `reportFailure` prints it as one `❌` line with exit 1 (or the `--json` error object). Importing the CLI, `--help`, `--version` and `init` never load the config
- `cooldown` accepts: number (days), duration string (`'1 week'`, `'24h'`), or per-update-type object `{ patch, minor, major }` whose values are themselves numbers or duration strings

### Update Policy (`updateChecker.ts`)
`updateChecker(info, policy)` is pure: it returns `{ target }` (where the package moves) or `{ reason }` (why it is held). `filterPackages` builds the policy per run with `policyFromConfig(config)`.
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
- One in-memory cache per CLI run, holding the in-flight request, so a package several workspace manifests declare is fetched once; `clearRegistryCache()` is exported for tests.
- Limitation: yarn berry's `.yarnrc.yml` and bun's `bunfig.toml` are not read in v1. Common case (npm-spec `.npmrc`) covers all four PMs.

### Manifest Specs (`files.ts`)
- Every writer builds the new spec with `nextVersionSpec()`: a single comparator (`^1.2.3`, `~1.2.3`, `1.2.3`) keeps its decorator, so an exact pin stays exact; an `npm:` alias keeps the alias and rewrites the spec inside it; a spec that can't keep its shape (`1.x`, `*`, `>=1 <2`, `^1 || ^2`) is written in the project's save style; git, file and URL specs are left alone
- Each adapter's `saveStyle(cwd)` reads that style where its manager's current version keeps it: npm `.npmrc` `save-exact` / `save-prefix`; pnpm `pnpm-workspace.yaml` `saveExact` / `savePrefix` (not `.npmrc`); yarn berry `.yarnrc.yml` `defaultSemverRangePrefix` (`''` = exact); bun `bunfig.toml` `[install] exact` or `.npmrc` `save-exact` (no prefix setting). Default `^`. Managers read it only when they write a beyond-range spec
- `catalog:` and `workspace:` references are never rewritten
- JSON manifests are written back in their own format (`formatLike`): the detected indentation (tabs or N spaces), CRLF or LF, and a final newline only if the file had one, so a bump changes one line
- `updatePNPMWorkspaceYAML` rewrites only entries under `catalog:` and under each named catalog in `catalogs:`; every other block (`overrides`, `peerDependencyRules`, settings) stays byte-for-byte. An entry keeps its quotes (`"` or `'`) and its trailing comment
- `buildUpdateDescriptors()` applies the same rule to produce `name@spec` for managers that write the manifest themselves (yarn), reading `dependencies`, then `devDependencies`, then `optionalDependencies`

### Package Grouping (`packageGrouper.ts`)
Groups packages by `@scope/` prefix. Unscoped packages go to a default group. Groups sorted alphabetically.

### Package Filtering (`filterPackages.ts`)
- Async. Signature: `filterPackages(outdated, { config, targetPackages?, cwd?, now?, overrides? })`; `config` is the project's loaded config, never loaded inside
- Runs `updateChecker` on every outdated package with the policy for `cwd`
- When cooldown is enabled (`cooldown > 0` for any update type), fetches release times from the registry for packages with a target and applies the gate
- Returns `UpdateResult[]` with name, current, wanted, latest, `target` (when updated), updateType (`current → target`, else `current → latest`), updated, reason, and optional `releaseAge`
- With `overrides` (the pipeline passes `adapter.overrides(cwd)`), a target outside the range of an override the manager enforces is held (`controlled by <field> (<range>)`), whatever the rules say; a held package names the override when `latest` is outside it too. Fields, as the current manager versions read them (verified by real installs): npm `overrides`; yarn berry `resolutions` (yarn v1 does not apply them to a direct dependency, so nothing is held); pnpm `overrides` in pnpm-workspace.yaml (pnpm 12 ignores `pnpm.overrides` / `resolutions` in package.json); bun `overrides` and `resolutions`. `$name` references and keys that only reach another package's dependencies (`a>b`, `a/b`, objects without `.`) don't pin
- Peer pass (`holdPeerConflicts`), when anything has a target: a target an installed package's peer range excludes is held (`peer conflict: <pkg>@<ver> needs <name> <range>`). Ranges from packages also moving in the run don't count (their new peers are unknown offline). Repeats until stable, since a hold can expose another conflict. A `latest` rule still moves, with `warning` set. Runs before cooldown, so held packages cost no network. ~22 ms for ~600 installed packages
- A workspace record expands to one `UpdateResult` per (package, manifest) (`expandWorkspaces`), each with `workspace`; single-package results have no `workspace` key. `holdTogether` holds a package's moving rows whenever another row of it is held while its range allows newer (`held with <path> (<reason>)`), because the in-range commands are workspace-wide; an exact pin blocks nothing. The peer pass and `holdTogether` repeat until nothing changes (`settle`), once before the cooldown and again after it, so a row held by either, or by the cooldown, stops counting as moving for the peer check. It is conservative for yarn v1, whose per-member commands could move one manifest alone
- `splitUpdates(results)` also returns `manifests` (`ManifestPlan[]`, root first, then by path) and divides the chosen updates into `withinRange` names (target == wanted: hand to the manager, write nothing) and `beyondRange` name → version (write the manifest spec first)
- Used by the pipeline's `plan` (update, dry-run, and interactive mode)

## Integration Points
- `src/commandRunner.ts` uses `runProcess` and `logger`
- `src/pipeline.ts` uses `filterPackages`, `logger`, `groupAndSortPackages`, `computeReleaseAges`, `toManifestNames`; adapters use `files.ts`, `overrides.ts`, `saveStyle.ts`, `npmrcLoader.ts`
- `src/commands/update.ts` uses `filterPackages` for dry-run and interactive mode
- `src/commands/init.ts` uses `saveJsonConfig` and `INITIAL_CONFIG`
