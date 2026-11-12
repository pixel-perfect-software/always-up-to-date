# Documentation Architecture

Documentation registry and index for the Always Up To Date project. This file maps all context documents across the 3-tier system.

## 3-Tier Documentation System

| Tier                 | Scope                                                     | Location                              |
| -------------------- | --------------------------------------------------------- | ------------------------------------- |
| 1 - Foundational     | Project-wide overview, dev commands, architecture summary | `/CLAUDE.md`                          |
| 2 - Component-Level  | Component purpose, patterns, integration points           | `src/{component}/CLAUDE.md`           |
| 3 - Feature-Specific | Granular feature implementation details                   | `src/{component}/{feature}/CLAUDE.md` |

## Documentation Registry

### Tier 1 (Foundational)

| Document            | Path                                          | Description                                                  |
| ------------------- | --------------------------------------------- | ------------------------------------------------------------ |
| Project Overview    | `/CLAUDE.md`                                  | Dev commands, architecture, conventions, engine requirements |
| Documentation Index | `.claude/context/ai-context/docs-overview.md` | This file - maps all documentation                           |

### Tier 2 (Component-Level)

| Component        | Path                     | Description                                                      |
| ---------------- | ------------------------ | ---------------------------------------------------------------- |
| Package Managers | `src/managers/CLAUDE.md` | Manager abstraction, CommandRunner, detection, workspace support |
| CLI Commands     | `src/commands/CLAUDE.md` | Commander.js setup, command registration, binary aliases         |
| Utilities        | `src/utils/CLAUDE.md`    | Config system, update logic, logging, file ops, package grouping |

### Tier 3 (Feature-Specific)

No Tier 3 documents yet. As features grow in complexity, add `CLAUDE.md` files in subdirectories (e.g., `src/managers/npm/CLAUDE.md`).

## Project Structure

```
src/
  index.ts                  # Entry point (shebang, calls cli)
  cli.ts                    # Commander.js program setup, registers commands
  types.ts                  # Core types: SupportedPackageManager, PackageInfo, UpdateResult, Reason, ReasonCode, AlwaysUpToDateConfig, CooldownConfig, RegistryConfig
  commandRunner.ts          # runCommand(pm, args, cwd, isSuccess?) via runProcess; runStep() tags failures
  project.ts                # openProject(cwd, { pm? }): locate(), the config (the member's own file, else the root's), the logger, detection, then adapter.projectRoot() for root (detection and the config again where it differs from locate's) → Project { root, member?, config, adapter, registry } (with a lazy registry session)
  projectLocation.ts        # locate(cwd): the nearest package.json's directory and the workspace root that lists it (package.json `workspaces`, or the nearest pnpm-workspace.yaml when it lists it), before a manager is known (#123)
  discovery.ts              # discoverFromRegistry(): native discovery for npm, pnpm, yarn v1, bun (manifests, node_modules, registry reader)
  pipeline.ts               # check / plan / update (take a Project): detect → discover → plan → apply → report for any adapter; refuseMemberApply() (#123)
  detectPackageManager.ts   # --pm, then packageManager, then devEngines.packageManager, then the adapters' lockfiles; lockfiles at the root, the declaration nearest the member up to the root
  stepError.ts              # StepError: failed pipeline step (detect/discover/apply) + manifestWritten
  commands/                 # CLI command definitions (commander, ./options and types only), options.ts (--pm, --no-cache), reportFailure.ts
    actions/                # check.ts, update.ts, init.ts: the action bodies, each loaded by its definition with await import() (#109)
    CLAUDE.md
  managers/                 # One adapter per package manager (adapter.ts interface, index.ts registry, names.ts the manager names with no adapter import)
    CLAUDE.md
  utils/                    # Shared utilities
    CLAUDE.md
scripts/
  build.mts                 # pnpm run build: empties dist/, bundles src/index.ts with esbuild into dist/index.js, fails on a warning, runs the checks in guards.ts, writes dist/third-party-licenses.txt; removes dist/ when a check fails (#109)
  guards.ts                 # GuardError, STARTUP_SOURCES / STARTUP_PACKAGES, packageOf, checkStartup (the metafile walk), checkExternals, writeLicenses: pure, so __tests__/scripts/ imports them
  package.json              # { "type": "module" }: Node loads guards.ts from build.mts as ESM with no MODULE_TYPELESS_PACKAGE_JSON warning (not a workspace member)
  tsconfig.json             # Type-checks scripts/ (module nodenext, erasableSyntaxOnly, allowImportingTsExtensions); check-types runs it after the root tsc
schema/
  config.schema.json        # JSON schema for .always-up-to-date.json (referenced via $schema)
  output.schema.json        # JSON schema (draft-07) for every `--json` stdout document: the plan document and the error document, version 1 (#201)
testRepos/                  # Integration fixtures, <manager>-<layout> (README.md); lockfiles are generated in temp copies, never committed
bench/                      # pnpm run bench: pinned/ and ranges/ (the 40-dependency benchmark manifests), run.ts (copy, install, hyperfine, the moving-rows guard, the untimed debug run for full packuments, three tables, the AUTD_BENCH_JSON document), targets.ts (selection, startupMode, jsonPathFrom, cold caches, MOVING_CONFIG / COOLDOWN_CONFIG), report.ts (hyperfine JSON parsing, the BenchDocument types and parseBenchDocument, medianDifference, fullPackumentReads, formatDifference, movingRows (the rows with outcome `update` of a v1 document; a 3.x array still reads, for `AUTD_BENCH_CLI`), tables), budgets.ts (pure: BUDGETS, legFrom, attemptOf, nextStep, verdictOf, exitCodeOf, annotationsOf, renderSummary), gate.ts (runGate with injected runBench / sleep / writeSummary / log; the real spawn of run.ts and the entry point; `pnpm run bench:gate`), register.cjs (swc loader for run.ts and gate.ts)
jest.integration.config.ts  # Jest config for the integration matrix (not part of pnpm test)
__tests__/
  integration/              # pnpm run test:integration: harness.ts (copy, pin to minimum, install, run the CLI and validate each `--json` document against the output schema, frozenInstall, snapshotFiles, runCliExpectingFailure), lockfiles.ts (yarn v1/berry/bun rewriters), expectations.ts (derived values, expectedPlan / expectedMemberPlan shared by check and plan, per-manager overrides), matrix.ts (runMatrix, runMemberMatrix), <manager>.test.ts
  scripts/                  # guards.test.ts (packageOf, checkStartup, checkExternals, writeLicenses on metafiles esbuild builds from temp fixtures, pnpm's .pnpm layout included), build.test.ts (the real scripts/ run by Node in a temp project: summary line, no warning, stale dist/ emptied, a failed check exits 1 and leaves no dist/)
  bench/                    # report.test.ts (hyperfine 2 JSON parsing, formatting and formatDifference, movingRows, table, throttledLines on real `--show-output` captures, #174; parseBenchDocument on the real document, damaged variants from structuredClone; medianDifference; fullPackumentReads on the real debug capture), targets.test.ts (selection, startupMode, jsonPathFrom, cold caches), budgets.test.ts (each budget at, below and above its limit, medians and negative differences, lower-of-attempts, the decision table, fail-closed on the real document's variants, summary text, annotations carry no row error), gate.test.ts (runGate with a fake runBench and sleep: the 30, 60 and 120 s waits and exit codes, no real sleeping)
  setup.ts                  # Global test setup (console suppression, AUTD_NO_CACHE=1)
  repoConfig.test.ts        # Repo configuration guards: coverage config measures all four managers and ignores only the re-export barrels; CI workflow runs Biome, the unit suite on Linux and Windows, the integration matrix per manager and the enforced perf gate per target; workflows pin every action to a release commit
  enginesWalk.test.ts       # #200 end to end through the real openProject, a local registry and the disk cache, runningNode mocked to 12.22.12: npm plans typescript 5.0.4 with four manifest requests (the packument is derived from the deps.dev capture) and a second session on the same cache sends none; pnpm keeps 5.1.6 held by #199 with one request; discovery alone (`findOutdated`) sends none and keeps its `wanted`
  versionManifests.test.ts  # #196 end to end: discovery alone (`findOutdated`) and an all-held `check` send no per-version request (the CLI's `check --json` plans, so it reads them); one request per moving name/target pair; none from a second plan or a new session on the same cache; a scoped package with .npmrc credentials
  index.test.ts             # CLI entry: a failure to start prints and exits 1
  cli.test.ts               # Loading the CLI reads no config
  project.test.ts           # openProject: config loaded once, logger configured before detection; the registry view loaded at the root, which projectRegistry.test.ts checks for a yarn v1 member over ~/.npmrc and its own .npmrc (#127)
  projectLocation.test.ts   # locate(): the root that lists a member, a directory inside one, a negated pattern, the nearest of several, pnpm's own yaml, a nearer pnpm-workspace.yaml that does not list it, no package.json (#123)
  projectMember.test.ts     # Real openProject from a member on temp workspaces: root and member, the config fallback, berry's detect refusal, the update refusal, an own-project directory, pnpm's own yaml, and the manager's root over locate's (a stray or nearer settings-only pnpm-workspace.yaml) (#123)
  memberRun.test.ts         # Per native adapter: check and plan from a member read that manifest only, the member header, and update is refused before discovery, any lookup or subprocess, with every manifest keeping its bytes (#123)
  discovery.test.ts         # Native discovery on registry captures: no subprocess, skipped specs, links, missing, failed lookups, #95, a member run (#123), a quarantined lookup left out (#166)
  projectRegistry.test.ts   # Real openProject on temp workspaces: a pnpm or bun member reads the workspace root's registry files; a pnpm member with its own yaml is its own root; a yarn v1 .yarnrc routes the default and a scope (#120) and a berry project's is ignored, from a member too; yarn v1 sends credentials by its own rule, npm by npm's (#126); berry routes and authenticates from .yarnrc.yml and reads no .npmrc (#107)
  releaseAgeGates.test.ts   # #168: pnpm, bun and npm release-age settings read from their files and env, and check through the real openProject against a local registry with set publish times, per manager's gate; a registry that is not public npm serving an old abbreviated `modified` still has a fresh version held (#177)
  integrationHarness.test.ts # The harness's pure helpers (pinWorkspaceYaml, the lockfile rewriters), and managerEnv keeping a developer's pnpm and bun global config out of a run (#175)
  pipeline.test.ts          # The pipeline plans with project.config and never loads it; reports a package the manager left in place; npm workspace rows; a cooldown fallback within the range package.json declares (#151) and an alias looked up by its target (#152); a deprecated target held from discovery's lookups, with no lookup of its own (#195); a license change held, a `latest` rule moving it with a warning, and one warning for rows with no manifest (#197); an npm lockfile-only project (no `node_modules`) holding a target whose own peer the lockfile's version fails (#198)
  outputSchema.test.ts      # #201: schema/output.schema.json compiles under Ajv strict mode and agrees with the code (reason codes, outcomes, managers, semver diff types); documents from real pipeline runs (single package, workspace, member) validate; every code and outcome validates; error documents; negative cases (a bare 3.x array, damaged documents); a later 4.x document (extra fields, an unknown code) validates against the published schema and fails the strict form (#218)
  singlePackageJson.test.ts # Snapshot of single-package check/plan/update JSON documents (registry captures as of the capture date plus a written node_modules, `autd` normalised to a placeholder), identical for all four managers; reviewed once for #106 and regenerated once for #201: never update it to make a change pass
  commandRunner.test.ts     # Success checks, stderr-at-debug, failure messages
  commands/
    check.test.ts, help.test.ts, init.test.ts, update.test.ts  # Command registration and options; help.test.ts runs the real program: `Usage: autd`, commander's `help [command]`, descriptions naming the four managers (#224); init writes to the nearest package.json's directory, update -i is refused from a member
    jsonOutput.test.ts      # Real logger: stdout is exactly one JSON document with --json (the versioned plan or error document)
    failures.test.ts        # Failed steps and a malformed config: exit code 1, one message, the JSON error document
    registryPathToken.test.ts # A token in a registry URL path never reaches a message: the client's errors, a fake npm's stderr, debug lines and the --json error object (#131)
  detectPackageManager.test.ts  # Detection order on real temp dirs: --pm, packageManager, devEngines, lockfiles; stray-lockfile logging; from a member, the root's declaration and lockfile, the member's own first, files named from the cwd (#123)
  startup.test.ts           # Loading the CLI loads none of the tracked modules: no action, pipeline, project, manager, logger, config, semver, colorette or @inquirer/prompts, and never the registry client, reader or cache (#109; the build's startup check covers every bundled input)
  fixtures/
    registry.ts, tls/       # Local registry/proxy servers (replies() for exact url tables, registryBody() which gunzips a .body.gz, derive()); test-only TLS material (generate.sh)
    registry/               # Verbatim curl captures (.body; .body.gz over 100 KB decoded) of dist-tags, deps.dev and packuments: ms, @types/ms, mkdirp, then yarn, pnpm, dayjs, debug, express, semver, zod, axios, lodash, next, qs, typescript for #106 (packuments only for yarn and pnpm); `<name>.<version>.manifest.body`, ten captures of one version's own document for #196 (async, minimatch, mkdirp, ms, @types/ms, react-redux, and a nonexistent ms version); README.md lists status, type, wire and decoded size and the checks; per-version manifests for #196-#197: ua-parser-js 1.0.39 (MIT) and 2.0.0 (AGPL-3.0-or-later), ms 2.1.1, pako 2.1.0 ((MIT AND Zlib)), and for #199 commander 14.0.0 (engines >=20) and eslint 9.0.0 (^18.18.0 || ^20.9.0 || >=21.1.0), listed in the README's "Licenses" section
    index.ts                # readFixture(), exitError(), fakeRegistry(), projectFor(), writeWorkspaceProject(), WORKSPACE_ENTRIES helpers; capturedPackage(name, { source, asOf }) and capturedRegistry(names, options) build RegistryPackage / a session from the captures, installPackages(cwd, dir, versions) writes node_modules, installCaptured(cwd, dir, name, version) writes one installed package from a version-manifest capture, capturedManifest(name, version) reads it, readRegistryBody() and derive() are re-exported from registry.ts
    bench/                  # document.json (a real `AUTD_BENCH_PM=npm AUTD_BENCH_JSON=… pnpm run bench` document, npm 11.19.1 on macOS arm64), check-debug.txt (a real `check` with `{ depsDev: false, debug: true, beyondRange: "major", cooldown: 7 }` on an installed `ms@2.0.0`, which prints the `Reading the full packument of ms` line; paths scrubbed, the sandbox's certificate-trust noise lines removed)
    outputSchema.ts         # validateOutput(document): Ajv 8.17.1 (test-only devDependency) compiled once, strict mode, from a strict form of schema/output.schema.json derived at load time (every object closed, reason.code an enum of REASON_CODES, #218); validatePublished(document) uses the schema as published
    reasons.ts              # reasonFor(message): the Reason a legacy reason string stands for, so tests state a row by its text
    cacheWriter.ts          # Child process for registryCache.test.ts's concurrent-writers test: puts one key repeatedly with a value only that writer could have made, so a reader can tell a whole entry from a torn one
    captured.test.ts        # The captured-registry helpers: sources, asOf, latest fallback, unplanned names, installPackages
    npm/ pnpm/ yarn/        # Real captured manager stdout/stderr: apply commands and errors (pnpm update, yarn v1 update/upgrade), berry's yarn.lock for testRepos/berry-workspace (`berry-workspace.yarn.lock`, #107), a yarn v1 member's package.json (devDependencies), npm's package-lock.json for #107 (a single package, testRepos/npm-workspace from `install --package-lock-only`, and `peers-no-node-modules.package-lock.json`, react 17.0.2 + react-redux 8.1.3, for #198)
  managers/
    adapters.test.ts        # Registry: adapterFor(name), one lockfile per manager, supportedManagers equals the adapters' keys in order
    npm.test.ts, pnpm.test.ts  # npm: readLockedPackages on package-lock.json captures (member's nested copy first, links), installedFromLockfile, a workspace with no node_modules listing its members (#107); pnpm: readWorkspace (workspace detection, catalog records, CRLF), single-package update paths, member map
    yarn.test.ts            # yarn v1: upgrade descriptors, a member's rows moved with root installs and each pin in its own field (manifest restored, beyond-range spec written, yarn.lock relocked; #127), the root keeping yarn's write, v1-over-stray-.yarnrc.yml, stderr warning at debug level, failed apply
    yarnBerry.test.ts       # yarn berry on the yarn.lock capture: readBerryLock (alias, builtin patch, workspace link), native check with no yarn command (from a member too), prefersLatestInRange, in-range and beyond-range apply checked in yarn.lock, failure flags (#107); a target's own peers judged from `readBerryLock` versions (#198)
    realSubprocess.test.ts  # Fake npm on PATH (sh wrapper / cmd-shim, all platforms): >1 MB output, names passed as arguments
    reuseDiscovery.test.ts  # update with a discovery result applies without discovering again (the throwing fake registry proves no lookup)
    withinRange.test.ts     # Native discovery on registry captures, default config: proposes exactly npm update's set; zero for pins
    applyRanges.test.ts     # In-range apply writes nothing; beyond-range writes the target spec first
    aliases.test.ts         # An npm: alias on all four managers: manifest key, looked up by the target, never by the key
    unusableRegistry.test.ts # #129: a registry value a manager cannot use (unparseable, not http(s), holding a variable) fails check/update with a discover StepError naming the file and key when a package routes through it, sending no request; pnpm's skip of a `${…}` in a project file; rows probed against npm, pnpm, yarn v1 and bun
    pnpmRegistries.test.ts  # pnpm yaml registry routes: both shapes, scopes, "@", ${…}, ecosystem, CRLF; env expansion for the global file; substitutePnpm
    pnpmWorkspaceYaml.test.ts # #229: one pnpm-workspace.yaml through every consumer (packages, member root, catalogs, overrides, save style, nodeVersion, registries, fetchTimeout, release-age gate): CRLF, BOM, comments, quotes, flow forms, tabs, anchors, indentation, empty values, duplicate keys, a tab before content, YAML scalars; the shared accessors
    pnpmNpmrc.test.ts       # pnpm 12 layers on temp dirs: #117 evidence rows, one test per probe decision (p20-p55), config directory per platform (Linux and Windows source-read), workspace members, `fetchTimeout` / `fetchRetries` from yaml and env only (#125)
    yarnNpmrc.test.ts       # yarn v1 .npmrc layers on temp dirs: #122 evidence rows, the comment's example, one test per probe decision (y20-y32), the filesystem root, berry reads no .npmrc (#107)
    yarnrc.test.ts          # yarn v1 .yarnrc grammar (quotes, comments, CRLF, --registry), routes, precedence against .npmrc, env and ~/.yarnrc, workspace parents; what yarnV1Auth carries (#126)
    yarnrcYml.test.ts       # yarn berry .yarnrc.yml: the YAML subset, substituteBerry on 4.18.1's grammar, file and env merge (r11-r15, `yarn config get` captures), berryRegistryConfig routes, unusable http, CA, network settings (#107), the release-age gate from npmMinimalAgeGate and npmPreapprovedPackages (#166)
    bunNpmrc.test.ts        # bun's .npmrc layers on temp dirs: project, one user file (XDG, userconfig), no env/prefix/parent, $VAR forms
    bunfig.test.ts          # bunfig.toml routes and credentials, $NAME, global/project merge, env overrides, bunfigExact
    pin.test.ts             # applyPinned on temp dirs: exact pin then a byte-for-byte restore, past-the-range spec, catalog entry, relock order, relock failure (#147)
    stepFailures.test.ts    # Each manager rejects with a discover/apply StepError
    workspaces.test.ts      # Member map: workspace patterns, negations, skips; listsMember and the same node_modules and dot-directory skips
    workspaceDiscovery.test.ts  # Workspace check on all four managers (native) returns one record; unnamed roots
    workspaceApply.test.ts  # Workspace apply per manager: commands, member manifest writes, catalog routing; yarn v1 members through the pin path, a nameless member included (#127)
    projectRoot.test.ts     # projectRoot on temp dirs: the npm/bun rule, pnpm's yaml (own yaml, catalog-only root), berry's yarn.lock root and its refusal, isYarnBerry from a member (#123)
  utils/
    config.test.ts          # Config loading/saving tests (incl. cooldown variants, strict depsDev, the member's file else the root's)
    cooldown.test.ts        # Normalize/evaluate cooldown gate
    duration.test.ts        # parseDuration + formatAgeDays
    files.test.ts           # checkIfFileExists, versionSpecs, manifests and catalogs (one file for the three modules split from files.ts, #230); readPnpmCatalogs / readBunCatalogs and their agreement with the pnpm writer
    yaml.test.ts            # parseYaml: URL keys, `>=` ranges against block scalar headers, nested flow sequences, tabs in blank lines, the `flowMaps` and `anchors` options and their absence for berry (#229)
    nodeFit.test.ts         # fitRunningNode (#200) on the typescript captures: 5.1.6 walked to 5.0.4 in three descending reads, the cap, an unknown manifest, a fitting target and no Node reading nothing, a deprecated or cooldown-gated candidate skipped, one walk for rows sharing it, an invalid engines range walked
    targetManifests.test.ts # readTargetManifests / targetManifestOf (#196): one read per name/target pair, aliases by the looked-up name, held and unmoved rows skipped, empty without versionManifest
    filterPackages.test.ts  # Package filtering, manifests read only for rows still moving (#196); the engines pass (#199): held against a declared range (member then root) or the running Node, `latest` warning, no `engines.node` moving, a Bun runtime skipped, pnpm's `nodeVersion` label, targeting, cooldown integration, cooldown fallbacks and pinned rows (#147), a fallback only within the declared range (#151), an alias judged by its target (#152), releaseTimes asked with { current, target } and never for a zero-day step, splitUpdates with pinMembers (#127); deprecated targets on registry captures: held past the range, moved with a warning under a `latest` rule or from an installed version with the same deprecation, the message on one line (#195); the license pass on ua-parser-js 1.0.39 and 2.0.0 captures: held, warned under `latest`, installed license from node_modules or the version manifest, unknown manifests moving (#197); a target's own peers (#198): held against an installed or moving peer, `latest` warning, missing and optional peers, a `workspace:*` range skipped, member then root rows, the injected `installed` reader
    reasons.test.ts         # OUTCOMES and REASON_CODES: no duplicates, 21 codes, every code has a SECTION_OF entry, reasonFor covers each code
    logger.test.ts          # Logger output, configure(), quiet and JSON output modes; report(): every row once under its outcome, merged manifests, summary line (#138); memberRun(), no manifest column in a member run (#123); the license section and summary (#197)
    npmrc.test.ts           # .npmrc parser: cases ported from ini 7, npm's ${VAR} substitution
    npmrcLayers.test.ts     # mergeNpmrcLayers (per key, origin), envLayer rules, npmrcFileLayer (substitute null leaves out ${…}), npmNpmrcLayers order and merge
    npmrcLoader.test.ts     # Layering (global, user, project, npm_config_*), workspace root, RegistryConfig, on temp dirs
    registryRequest.test.ts # Pure client helpers: scoped registry, prefix walk, Authorization forms, yarn v1's credential rule on the c01-c20 probe rows (#126), berry's on r01-r30 (#107), retry rules, throttledNotice (#174), public-registry check, dist-tags and deps.dev URLs, versionManifestUrl (#196), package-name rule
    registryClient.test.ts  # node:https client against local HTTP(S) servers and a CONNECT proxy: auth, TLS, mTLS, proxies, retries, timeout, maxsockets, redirects, per-request accept/timeout/retries, stats() with 429s counted per host (#174); yarn v1's rule on the wire, a redirect keeping the header on the same hostname (#126); berry's rule, a redirect keeping it on the same origin only (#107)
    registry.test.ts        # createRegistrySession: lazy config and client, one per run, releaseTimes() on @types/ms captures (a lookup, then one full packument; fails open; scoped registry and credentials, #104), close(), one warning at close() naming each host that throttled the run (#174), lookup() sharing the client and honoring depsDev, releaseTimes() answered from deps.dev's dates (#139), and behind a pnpm-shaped release-age gate (one full request for a lagging deps.dev, none after); behind the gate, a package modified before it asks only the abbreviated packument, a non-public registry gates to the same versions, a cooldown window still reads the full one, a 304 on an entry without `modified` reads it (#177); lookedUp() answers only what the session looked up (#195); versionManifest() (#196): memoized including failures, never rejects, an unusable route refused, forwarded ungated
    registryReader.test.ts  # createRegistryReader on captured bodies and local servers: deps.dev path, packument fallbacks, breaker, depsDev: false, other registries, credentials, 404s, failures, dedupe, bounded concurrency; releaseTimes (#47): deps.dev's times kept on the packument path, no packument request for a name deps.dev lists, the window, one full request per name, only listed versions, failures, the limiter; with the disk cache: TTLs, a package deps.dev lags on (no request while a fresh packument lists `latest`, deps.dev asked once more otherwise), 304 revalidation, Q1 (authenticated answers), Cache-Control, no stale fallback, unwritable folder, the coverage rule on packument-full (any age, a missing version revalidates and replaces, authenticated and no-cache asked every run, no token stored); `modified` on a public registry's packument lookup only, kept by the cache whatever the registry (#177); versionManifest() (#196): no request for an invalid name, non-canonical or unlisted version, one per pair, deprecation overlay, the `manifest` cache kind's reuse and revalidation, credentials
    registryCache.test.ts   # The store: cacheDirectory per platform, endpointKey, freshFor, round trips, misses, atomic writes across processes, pruning, fails open, modes; the `manifest` kind's TTL, key and reuse rule (#196); an entry without `modified` still reads, a non-string one is a miss (#177)
    registryDocuments.test.ts # dist-tags, deps.dev, packument and version-manifest parsers (legacy license forms, #196) on the fixtures; the sources agree; malformed input; non-string and unlisted-version `time` entries; the abbreviated `modified` (an upper bound on the full capture's times; absent from a full document or a bad value, #177)
    releaseAgeGate.test.ts  # A manager's release-age gate (#166) on registry captures: per-scope minutes, npmPreapprovedPackages forms, latest moved below a quarantined one, no time quarantined, the full packument's times filling a packument, quarantined lookups, releaseTimes filtered and a cooldown's window forwarded; the packument `modified` answers a gate that allows a missing time with no publish-time read: past, exactly at, inside, a `held` gate, npm's `before`, no or future `modified` (#177); lookedUp() returns the gated answer (#195); versionManifest forwarded ungated (#196)
    limiter.test.ts         # createLimiter: peak, FIFO, rejection frees the slot
    runProcess.test.ts      # Real child processes: no output cap, no shell, Windows quoting
    updateChecker.test.ts   # Update policy: within range, beyondRange levels, rules, legacy mapping
    overrides.test.ts       # Which override keys pin a package, per manager's current version
    peers.test.ts           # Installed peer ranges from hoisted node_modules and the pnpm store; an orphan `.pnpm/lock.yaml` no longer lists is skipped (#146)
    saveStyle.test.ts       # Where each manager keeps save-exact / save-prefix
    workspaceRows.test.ts   # foldWorkspaceEntries ordering and top-level choice
    installed.test.ts       # Installed root-dependency versions (hoisted, scoped, alias, pnpm symlink); readInstalledPackages linked detection (junction to a member, pnpm store link, link outside the project); checkApplied, a cooldown fallback installed exactly (#151); `declaredOnly: false` reads an undeclared package; readInstalledManifests: the member's nested copy first, only a copy at the row's `current` (#197)
    wanted.test.ts          # wantedVersion on the yarn and pnpm captures, each on deps.dev and on the packument
    dependencySpecs.test.ts # classifySpec table; readDeclaredDependencies on temp dirs (field order, peers, catalogs, members, unreadable manifest); declaredDependency (#151, #152)
    aliasSpec.test.ts       # parseAlias / parseBareAlias (`npm:` specs) and isRecord
    engines.test.ts         # runningNode, declaredNodeRange (universal and invalid values), enginesHold: the declared range by subset (touching pieces held), the running Node, a label (#199)
    license.test.ts         # licenseField (string, `{ type }`, `licenses[]`), normalizeLicense and sameLicense: case, whitespace, parentheses, operand order, GNU ids and `SEE LICENSE IN` are no change; `MIT/X11` and `Apache 2.0` are (#197)
```

## Tech Stack

- **Language:** TypeScript, type-checked by `tsc` (which emits nothing) and bundled by esbuild 0.28.2 into one CommonJS file, `dist/index.js` (`scripts/build.mts`)
- **CLI Framework:** Commander.js
- **Package Manager:** pnpm (>=12.0.0)
- **Node:** ^22.23.0 || >=24.17.0 (`.tool-versions` pins 24.22.1)
- **Testing:** Jest + @swc/jest
- **Linting/Formatting:** Biome
- **Path Aliases:** `@/*` -> `src/*` (resolved by esbuild from `tsconfig.json` `paths` at build)
- **Key Dependencies:** the one runtime dependency is `@inquirer/prompts` (external, loaded by `update -i`); commander, colorette and semver are devDependencies inlined into the bundle, with their licenses in `dist/third-party-licenses.txt` (registry metadata for cooldown comes from our own `node:https` client and `.npmrc` parser, no dependency)
