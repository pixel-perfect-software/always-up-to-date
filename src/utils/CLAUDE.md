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
- Cooldown's network path (`releaseTimes`, npmrcLoader) fails open: a transient error never blocks an update. The reader (`lookup`) does not: it reports each failure per package as `{ ok: false, kind, reason }` and the consumer decides. Don't "fix" it to return an empty or partial result, which would turn an outage into "no versions"

## Major Subsystem Organization
```
utils/
  index.ts            # Barrel: re-exports runProcess, config, cooldown, duration, logger, filterPackages, npmrcLoader, packageGrouper, registry, updateChecker, files
  runProcess.ts       # runProcess() (execFile + args, no output cap), buildWindowsCommand()
  config.ts           # loadConfig(), saveJsonConfig(), DEFAULT_CONFIG, INITIAL_CONFIG, ConfigError
  cooldown.ts         # normalizeCooldown(), isCooldownEnabled(), cooldownDaysFor(), evaluateCooldown()
  duration.ts         # parseDuration() (number | '1 week' | '24h' → days), formatAgeDays(), MS_PER_DAY
  npmrc.ts            # parseNpmrc(text, env), substituteEnv(): the .npmrc parser (pure)
  npmrcLoader.ts      # loadNpmrc() layers global, user, project, npm_config_* env as npm 12 does; loadRegistryConfig() returns RegistryConfig
  registryRequest.ts  # Pure client helpers: registryFor, packumentUrl, distTagsUrl, depsDevUrl, isPublicNpmRegistry, isValidPackageName, credentialsFor, authorizationFor, retry rules
  registryClient.ts   # node:https transport (agents, gzip, per-request accept and timeout, retries, redirects, per-host stats()); loaded lazily by registry.ts only
  registry.ts         # createRegistrySession(cwd, { depsDev }): one lazy .npmrc view and one client per run; releaseTimes() with in-flight per-run cache, fails open; lookup() via the lazy reader
  registryReader.ts   # createRegistryReader(): latest, versions, deprecation, publish times per package (dist-tags + deps.dev, packument fallback); loaded by registry.ts only
  registryDocuments.ts # Pure parsers: parseDistTags, parseDepsDevPackage, parsePackument; loaded by the reader only
  limiter.ts          # createLimiter(max): FIFO cap on in-flight tasks; the reader makes one per host; loaded by the reader only
  updateChecker.ts    # Update policy: within range by default, beyondRange level, per-package rules (pure)
  rows.ts             # toOutdatedRow() / toOutdatedRows() / toUpdatingRow(): display rows (in-range note, shown only when `wanted` differs from `latest` and `current` and is ahead of `current` or `current` is `missing`; beyond-range flag; one outdated row per manifest in a workspace)
  overrides.ts        # overridesFromField(), manifestOverrides(cwd, fields): packages an override pins, with field and range
  peers.ts            # readInstalledPeers(cwd): installed peer ranges by constrained package (node_modules, pnpm store)
  saveStyle.ts        # SaveStyle, DEFAULT_SAVE_STYLE, readTextFile(), yamlValue(): what adapters' saveStyle() builds on
  dependencySpecs.ts  # DEPENDENCY_FIELDS, DISCOVERED_FIELDS (no peers), classifySpec(key, spec, catalogs) (catalog:, workspace:, npm: alias, a bare `npm:<name>` is `latest` of that name as npm reads it, skipped git/file/link/URL, latest, other dist-tag warns), readDeclaredDependencies(cwd, { manifests, catalogs }): every manifest's registry dependencies, first field wins, unreadable manifest is a `discover` StepError. Not in the barrel; `src/discovery.ts` uses it
  wanted.ts           # wantedVersion(range, pkg, { preferLatest }): exact pin, else `latest` if it satisfies and isn't deprecated, else highest non-deprecated, else highest satisfying (pure; `src/discovery.ts` uses it)
  aliasSpec.ts        # parseAlias(spec) (`npm:<target>@<range>`) and parseBareAlias(spec) (`npm:<target>`): the one alias definition for dependencySpecs, files.ts (`nextVersionSpec`) and berry. Imports nothing
  isRecord.ts         # isRecord(value): the one plain-object guard (files.ts, registry.ts, registryDocuments.ts, berry.ts). Imports nothing, so startup stays lean
  workspaceRows.ts    # foldWorkspaceEntries(entries): one PackageInfo per name with `workspaces`; expandWorkspaces(record): the inverse, one row per manifest; workspaceLabel(path): `(root)` or the path
  installed.ts        # readInstalledPackages(cwd, rows, { links }) returns `{ version, linked }` (resolves the project's real path once per call; `links: false` skips the link test and `linked` is always false, which is what `readInstalledVersions` and the post-apply check use; linked: a symlink or junction to a directory inside the project and outside node_modules, i.e. a workspace member; pnpm and bun store links are not), readInstalledVersions(cwd, rows) is its versions: each moving row's installed version (the pipeline uses an adapter's own `installed()` instead when it has one: yarn berry, PnP), keyed by `rowKey` (the name, plus `<workspace>:` in a workspace project), read from `<member>/node_modules/<name>` first, then the root's, only for names that manifest declares; checkApplied(): rows the manager left in place become `not applied by <pm> (installed …)`
  filterPackages.ts   # Async batch filtering with cooldown gating, returns UpdateResult[]
  packageGrouper.ts   # Groups packages by @scope for display
  logger.ts           # Colored logging (colorette); configure(config) takes `debug`, `silent` and the deprecated allow/deny lists (defaults before it: debug off, not quiet, no lists), setQuiet() silences all, setJsonOutput() drops progress and sends errors/warnings/debug to stderr
  files.ts            # checkIfFileExists(), updatePackageJson(), updatePNPMWorkspaceYAML() (on the shared catalog walk), readPnpmCatalogs(yaml), readBunCatalogs(manifest) (reads `workspaces.catalog(s)` too), updateBunCatalogs(), readSpec(), splitCatalogUpdates(), buildUpdateDescriptors()
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

### Registry / .npmrc (`npmrc.ts`, `npmrcLoader.ts`, `registryRequest.ts`, `registryClient.ts`, `registry.ts`)
- `parseNpmrc(text, env)` is ini 7's decode (quoting, `;`/`#` cuts, `key[]` arrays, parsing stops at the first `[section]`, `__proto__` skipped) plus npm's `${VAR}` substitution: an unset `${VAR}` stays literal, `${VAR?}` is empty, `\${VAR}` is escaped
- `loadNpmrc(cwd, sources)` merges four layers, later wins: global (`<prefix>/etc/npmrc`), user (`~/.npmrc`), project, `npm_config_*` env (any case, `_` → `-`). The project file is the `.npmrc` of the npm project root: from a workspace member, the root's. `NpmrcSources` (env, home, execPath, platform) is injectable for tests; an unreadable file is an empty layer
- `registryConfigFrom(npmrc, cwd, sources)` builds `RegistryConfig` (registry, `scopedRegistries`, `credentials` by `//host[:port]/path/` prefix, `ca`, `strictSSL`, `proxy`, `fetchRetries`, `fetchTimeout`, `maxSockets`). Unscoped `_authToken` and `always-auth` are ignored, as npm 9+ does
- `session.releaseTimes(name)` (from `createRegistrySession(cwd)`) picks the registry by scope, GETs the full packument (corgi format strips `time`) through `registryClient`, and maps `time` to `Record<version, ISO>`. Any failure → empty map (cached) and a debug line, so the cooldown gate fails open
- The client sends credentials only to the longest `.npmrc` prefix that matches the request URL, and recomputes them on each redirect. Retries cover 408, 420, 429, 5xx, ECONNRESET, ECONNREFUSED and ETIMEDOUT with a short capped backoff; a `Retry-After` over 1 s stops retrying
- `registry.ts` imports `registryClient` with `await import()` on the first request, so nothing heavy loads at startup; keep top-level imports there to types, `registryRequest`, `npmrcLoader` and `logger`
- `openProject` makes one `RegistrySession` per run (`Project.registry`): `registryConfig()` reads the `.npmrc` layers and `cafile` on its first call, `client()` creates the one client, so every registry request in the run shares both. A session reads and loads nothing until asked; `close()` destroys the agents (safe twice, or before any request) and commands call it in a `finally`. `loadConfig`, `clientOptions` and `endpoints` are test seams; `depsDev` is the config switch
- `getJson(url, registry, { signal, accept, timeout, retries })`: `accept` defaults to `application/json`, `timeout` to `fetch-timeout` (ms), `retries` to `fetch-retries`; all hold across redirects and retries. The reader sends deps.dev requests with `retries: 0`. `stats()` returns copies and counts per `url.host`: `responses` (every status), `bodyBytes` (2xx bodies as received) and `decodedBytes` (after gunzip)
- `session.lookup(name)` (`registryReader.ts`, loaded with `await import()` on the first call) returns a `PackageLookup` and never rejects for a network, HTTP or parse failure:
  - An invalid name (`isValidPackageName`) is `invalid` with no request. A public npm name (registry root is `https://registry.npmjs.org/` or `https://registry.yarnpkg.com/`) fetches `/-/package/<name>/dist-tags` and deps.dev together. When deps.dev lists `latest` the result is `source: 'deps.dev'`; otherwise (deps.dev 404, 429, 5xx, unreachable, unreadable, or `latest` missing) the abbreviated packument is read. A dist-tags 404 is `not-found`; any other dist-tags failure takes the packument path
  - Any other registry, a scope's registry, or `depsDev: false` takes one GET with `ABBREVIATED_ACCEPT`, retried once with `application/json` on a 404 (as pacote does). The packument's own `latest` is used when it lacks the dist-tags' one, else the highest stable version
  - deps.dev gets only its own URL as the client's registry base, so no `.npmrc` credentials go to it. A 429 or a timeout turns deps.dev off for the rest of the run (one debug line). Any other 5xx or transport failure falls back to the packument for that package only, and the third such failure in a run turns deps.dev off; a 404 does not count. The decision is made inside the failed request's limiter slot, before the next queued request starts. deps.dev requests time out at `min(fetch-timeout, 5 s)` with no retries, and a request still queued when the breaker trips is skipped once it reaches the front
  - Requests go through one limiter per host (`new URL(url).host`), each of `maxsockets`, the client's per-host agent cap: a queued request never waits in an agent queue and burns its timeout, and only that many packument bodies per host are buffered at once. With two hosts (dist-tags and deps.dev), up to `2 × maxsockets` requests are in flight; measured 2026-10-26 on the 40-package benchmark, lookups took 0.57–0.70 s against 0.75 s with one run-wide limiter
  - A body the client cannot parse as JSON is a `request` failure; a JSON body that is not a packument is `invalid`. `not-found` and `invalid` reasons name the registry's host; a `request` reason is the client's message, which carries the URL without userinfo, query or credentials
  - Keep `registryReader`, `registryDocuments` and `limiter` out of the barrel as values (`export type` is fine): the barrel loads at startup
- The cache is per session and holds the in-flight request, so a package several workspace manifests declare is fetched once; a new session asks again
- Limitation: yarn berry's `.yarnrc.yml` and bun's `bunfig.toml` are not read in v1. Common case (npm-spec `.npmrc`) covers all four PMs.

### Manifest Specs (`files.ts`)
- Every writer builds the new spec with `nextVersionSpec()`: a single comparator (`^1.2.3`, `~1.2.3`, `1.2.3`) keeps its decorator, so an exact pin stays exact; an `npm:` alias keeps the alias and rewrites the spec inside it; a spec that can't keep its shape (`1.x`, `*`, `>=1 <2`, `^1 || ^2`) is written in the project's save style; git, file and URL specs are left alone
- Each adapter's `saveStyle(cwd)` reads that style where its manager's current version keeps it: npm `.npmrc` `save-exact` / `save-prefix`; pnpm `pnpm-workspace.yaml` `saveExact` / `savePrefix` (not `.npmrc`); yarn berry `.yarnrc.yml` `defaultSemverRangePrefix` (`''` = exact); bun `bunfig.toml` `[install] exact` or `.npmrc` `save-exact` (no prefix setting). Default `^`. Managers read it only when they write a beyond-range spec
- `catalog:` and `workspace:` references are never rewritten
- JSON manifests are written back in their own format (`formatLike`): the detected indentation (tabs or N spaces), CRLF or LF, and a final newline only if the file had one, so a bump changes one line
- `updatePNPMWorkspaceYAML(cwd, versions, style, catalog?)` rewrites only entries under `catalog:` and under each named catalog in `catalogs:`; every other block (`overrides`, `peerDependencyRules`, settings) stays byte-for-byte. With `catalog` (`default` for `catalog:`) only that catalog moves, so `catalog:react18` never rewrites `react19`'s entry; the adapters call it once per catalog from `splitCatalogUpdates()`, which returns `catalogs` (catalog → name → version). An entry's value is read whole (`>=18.0.0 <19`, `"^17 || ^18"`, up to a trailing ` #` comment) and replaced whole; it keeps its quotes and its comment
- Bun reads `workspaces.catalog` / `workspaces.catalogs` as well as the top-level fields; when the `workspaces` one is set it replaces the top-level one as a whole, per field (verified on bun 1.4.4). `readBunCatalogs` and `updateBunCatalogs(cwd, versions, style, catalog?)` follow that
- `buildUpdateDescriptors()` applies the same rule to produce `name@spec` for managers that write the manifest themselves (yarn), reading `dependencies`, then `devDependencies`, then `optionalDependencies`

### Package Grouping (`packageGrouper.ts`)
Groups packages by `@scope/` prefix. Unscoped packages go to a default group. Groups sorted alphabetically.

### Package Filtering (`filterPackages.ts`)
- Async. Signature: `filterPackages(outdated, { config, registry, targetPackages?, cwd?, now?, overrides? })`; `registry` is `Pick<RegistrySession, 'releaseTimes'>`, the project's session; `config` is the project's loaded config, never loaded inside
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
- `src/pipeline.ts` uses `filterPackages`, `logger`, `groupAndSortPackages`, `computeReleaseAges`; adapters use `files.ts`, `overrides.ts`, `saveStyle.ts`, `npmrcLoader.ts`
- `npmrcLoader.ts` uses `@/managers/workspaces` to find the npm project root (no cycle: `workspaces.ts` imports only the logger and `StepError`)
- `src/commands/update.ts` uses `filterPackages` for dry-run and interactive mode
- `src/commands/init.ts` uses `saveJsonConfig` and `INITIAL_CONFIG`
