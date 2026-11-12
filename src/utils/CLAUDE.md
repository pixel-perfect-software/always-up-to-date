# Utilities - Component Context

## Purpose

Shared utilities: configuration, the update policy and the plan, cooldown and durations, the registry client and its `.npmrc` view, discovery helpers, manifest writing, the report and logging, subprocesses.

Detail that loads only when read (each file links back here):

- `REGISTRY.md`: `.npmrc` layers, `RegistryConfig` and unusable values, the session, client, lookup, publish times, version manifests, the disk cache, the release-age gate, redaction. Read before touching `npmrc*`, `registry*`, `reader*`, `releaseAgeGate`, `redaction`, `limiter` or `errorFields`
- `plan/CLAUDE.md`: `filterPackages` and every plan pass, in order (overrides, peers, cooldown and its fallback, deprecation, manifests, engines walk-back, license, engines, target peers, held together), and `splitUpdates`. Read before touching `filterPackages.ts`, `targetManifests.ts` or `plan/`
- `MANIFESTS.md`: spec shapes, manifest and catalog writers, save style. Read before touching `versionSpecs`, `manifests`, `catalogs` or `saveStyle`
- `OUTPUT.md`: the human report's sections and notes, reasons, `--json` rows. Read before touching `report`, `logger.report`, `reasons` or `jsonDocument`

## Guidelines

- Import leaf modules (`@/utils/logger`, `@/utils/runProcess`); `src/utils` has no barrel
- `runProcess(file, args, { cwd })` is the only way to start a subprocess: `execFile` with no shell and `maxBuffer: Infinity`. On Windows, where npm/pnpm/yarn are `.cmd` shims Node only starts through cmd.exe, it runs `buildWindowsCommand()` through the shell, double-quoting arguments that contain cmd.exe operators (the windows-latest CI jobs cover it: the `.cmd` shim test in runProcess.test.ts, realSubprocess.test.ts through `npm.cmd`, and the integration matrix against real npm, pnpm, yarn and bun on Windows)
- `runProcess` passes `env: process.env` explicitly; under Jest the sandbox env otherwise never reaches the child, so PATH-shim tests depend on it
- Config uses nullish coalescing with `DEFAULT_CONFIG` for safe merging
- Cooldown's network path (`releaseTimes`, npmrcLoader) never throws: a transient error leaves the times the lookup had (an empty map when it had none), and the cooldown gate then holds the target as `release date unknown` (#139). The reader (`lookup`) does not: it reports each failure per package as `{ ok: false, kind, reason }` and the consumer decides. Don't "fix" it to return an empty or partial result, which would turn an outage into "no versions"
- Startup: the registry client, reader, cache, documents and limiter load only through `await import()` from `registry.ts` (`REGISTRY.md`); `aliasSpec.ts`, `isRecord.ts` and `reasons.ts` import nothing, so anything may import them

## Files

```
utils/
  runProcess.ts       # runProcess() (execFile + args, no output cap), buildWindowsCommand()
  config.ts           # loadConfig(workingDir, fallbackDir?, onWarning?), configFileFor(), saveJsonConfig(), CONFIG_SCHEMA_URL, DEFAULT_CONFIG, INITIAL_CONFIG, ConfigError
  cooldown.ts         # normalizeCooldown(), isCooldownEnabled(), cooldownDaysFor(), evaluateCooldown(); plan/CLAUDE.md
  duration.ts         # readDuration() (undefined when unreadable), parseDuration() (number | '1 week' | '24h' → days, 0 when unreadable), formatAgeDays(), MS_PER_DAY; plan/CLAUDE.md
  npmrc*.ts, registry*.ts, reader*.ts, redaction.ts, limiter.ts, errorFields.ts, releaseAgeGate.ts  # REGISTRY.md
  yaml.ts             # parseYaml(text, { flowMaps?, anchors? }): the YAML subset reader for berry's .yarnrc.yml and yarn.lock and pnpm's settings files (below)
  updateChecker.ts    # Update policy: within range by default, beyondRange level, per-package rules (pure); plan/CLAUDE.md
  filterPackages.ts, targetManifests.ts, plan/  # plan/CLAUDE.md
  overrides.ts        # overridesFromField(), manifestOverrides(cwd, fields): packages an override pins, with field and range
  engines.ts          # runningNode() (null under Bun), declaredNodeRange(value, file) (a real `engines.node` constraint, else undefined), enginesHold(targetRange, { declared, running, runningLabel }) → the `engines: needs node …` reason, npmAcceptsNode(enginesNode, node) (npm-install-checks' `checkEngine`: an invalid range fails, unlike `enginesHold`) and shownRange() (trim) (#199, #200)
  license.ts          # licenseField(manifest) (`license` string, legacy `{ type }`, `licenses[]`), normalizeLicense(), sameLicense(a, b): no SPDX dependency; `parseVersionManifest` uses licenseField (#197)
  peers.ts            # readInstalledPeers(cwd): installed peer ranges by constrained package (node_modules, and the pnpm store entries `.pnpm/lock.yaml` lists); the lockfile's readers stand in for it where an adapter's `LockedInstall.peers` answers (#232)
  dependencySpecs.ts  # DEPENDENCY_FIELDS, DISCOVERED_FIELDS (no peers), declaredDependency(cwd, workspace, key, catalogs) (what a manifest declares under a key, as discovery reads it: the name looked up, an alias's target, and its spec; the plan's cooldown reads it), classifySpec(key, spec, catalogs), readDeclaredDependencies(cwd, { manifests, catalogs }); `src/discovery.ts` uses it
  wanted.ts           # wantedVersion(range, pkg, { preferLatest }): exact pin, else `latest` if it satisfies and isn't deprecated, else highest non-deprecated, else highest satisfying (pure; `src/discovery.ts` uses it)
  aliasSpec.ts        # parseAlias(spec) (`npm:<target>@<range>`) and parseBareAlias(spec) (`npm:<target>`): the one alias definition for dependencySpecs, versionSpecs.ts (`nextVersionSpec`) and berry
  isRecord.ts         # isRecord(value): the one plain-object guard (catalogs.ts, registry.ts, registryDocuments.ts, berry.ts)
  workspaceRows.ts    # foldWorkspaceEntries(entries): one PackageInfo per name with `workspaces`; expandWorkspaces(record): the inverse, one row per manifest; workspaceLabel(path): `(root)` or the path
  installed.ts        # readInstalledPackages(), readInstalledVersions(), readInstalledManifests(), checkApplied(): `.claude/context/ai-context/pipeline.md`, Installed versions
  versionSpecs.ts, manifests.ts, catalogs.ts, saveStyle.ts  # MANIFESTS.md
  reasons.ts, jsonDocument.ts, report.ts  # OUTPUT.md; jsonDocument is loaded by the actions and reportFailure only
  logger.ts           # Colored logging (colorette), below
  ancestors.ts        # ancestorFiles(cwd, name): a file's name in cwd and each parent, nearest first (yarn v1's .npmrc and .yarnrc); ancestorDirs(from, to): the directories from `from` up to `to`, nearest first (detection's declarations, isYarnBerry)
  files.ts            # checkIfFileExists(): config.ts and init's only import from here, so neither loads a writer
```

- `yaml.ts`: a plain key ends at the first `:` followed by a space or the end (a URL key keeps its colons); `|` / `>` open a block scalar only with a header after them (`>=18 <19` is text); a tab before content empties the file, one in a blank or comment line doesn't. `flowMaps` reads a flat one-line flow map and `anchors` an anchored value: pnpm's reading turns both on (`managers/pnpm/workspaceYaml.ts`), berry's leaves both off, so berry still drops a flow map or an anchored key
- `logger.ts`: `configure(config)` takes `debug` and `silent` (defaults before it: debug off, not quiet); `report(results, manager, phase, { member? })` prints the grouped report and its summary line (`OUTPUT.md`); `setQuiet()` mutes progress, the report, warnings and debug but never an error; `setJsonOutput()` drops progress. Emoji markers only on a terminal without `NO_COLOR` (`emojiAllowed`, decided once per stream; `FORCE_COLOR` on a pipe keeps color, not emoji): otherwise `info` and `success` have no marker, a warning `!` and an error `error:` (#225). Errors, warnings and debug lines go to stderr in every mode (#223), a debug line behind a gray `debug` label; `warn(message, { always })` for a warning that belongs to an error. Human output goes through `logger`, never `console.log`

## Configuration (`config.ts`)

- Config file: `.always-up-to-date.json` in the project root. `loadConfig(workingDir?, fallbackDir?, onWarning?)` reads JSON, merges with `DEFAULT_CONFIG`. `configFileFor(workingDir, fallbackDir?)` is the file it reads: the working directory's own, else the fallback's, with no per-key merge. A member run (#123) passes the member's directory and the workspace root, so a member's file replaces the root's whole. Only `openProject` (`src/project.ts`) calls it for a command run (again only when the manager's project root is not `locate`'s); everything else takes the loaded config as a parameter. `onWarning` receives the unknown-key warnings: `openProject` collects them and prints them with `logger.warn` right after `logger.configure`, since the logger's `silent` and `--json` handling come from the config being loaded
- `saveJsonConfig(config, filePath)` writes formatted JSON; `autd init` writes `$schema` (`CONFIG_SCHEMA_URL`, pointing at `schema/config.schema.json`, for IDE autocomplete and validation) then `INITIAL_CONFIG` (`beyondRange`, `rules`, `cooldown`, `debug`, `silent`), never the deprecated fields
- Schema: `AlwaysUpToDateConfig` (see `src/types.ts`); `ConfigFile` is any subset of it plus `$schema`
- Fields: `beyondRange` (`"none"` default | `"patch"` | `"minor"` | `"major"`: how far past its range a package may move, to `latest`, exact pins included); `rules` (per package or `*` glob: `"hold"`, `"followRange"`, `"latest"`); `cooldown`; `depsDev` (`true` default: every public npm name is looked up at deps.dev in discovery unless it is `false`); `debug` / `silent`. Deprecated, still read: `allowMinorUpdates` / `allowMajorUpdates` (→ `beyondRange`), `updateAllowlist` / `updateDenylist` (→ `latest` / `hold` rules); the new fields win when both are set
- `beyondRange` and `rules` are validated strictly: an unknown level or rule throws instead of being ignored (ignoring `"react": "hodl"` would update a package meant to be held). `beyondRange` stays `undefined` when absent so the deprecated fields can still decide
- Every load failure (malformed JSON, invalid value) is a `ConfigError`. `openProject` throws it inside the command's `try`, so `reportFailure` prints it as one error line with exit 1 (or the `--json` error object). Importing the CLI, `--help`, `--version` and `init` never load the config
- `cooldown` accepts: number (days), duration string (`'1 week'`, `'24h'`), or per-update-type object `{ patch, minor, major }` whose values are themselves numbers or duration strings; `0` (the default) is off. Anything `readDuration` cannot read (`"30 dyas"`, `-3`, `""`, `null`) and any other per-type key (`mnior`) is a `ConfigError` naming the key and the value (#217): a typo must not turn a supply-chain gate off
- `debug`, `silent`, `depsDev` and the deprecated `allowMinorUpdates` / `allowMajorUpdates` take `true` or `false` only (`"false"` and `1` are errors, not coerced). A top level that is not a JSON object (an array, `null`, a string) is a `ConfigError`. An unknown top-level key is a warning naming it and the known key within two edits of it, case ignored (`beyondrange` → `beyondRange`); `$schema` and the deprecated keys are known. `schema/config.schema.json`'s duration patterns accept the same strings as `readDuration` (a test compares them)

## Integration Points

- `src/commandRunner.ts` uses `runProcess` and `logger`
- `src/project.ts` calls `loadConfig`, `createRegistrySession`, `withReleaseAgeGate` and `trackRegistries`; `src/discovery.ts` uses `dependencySpecs`, `installed`, `wanted` and `workspaceRows`
- `src/pipeline.ts` `plan` uses `filterPackages` (update, `--dry-run` and `-i` all plan through it), and `logger`; adapters use `manifests.ts`, `catalogs.ts`, `versionSpecs.ts`, `overrides.ts`, `saveStyle.ts`, `npmrcLoader.ts`
- `src/commands/actions/init.ts` uses `saveJsonConfig`, `CONFIG_SCHEMA_URL` and `INITIAL_CONFIG`
