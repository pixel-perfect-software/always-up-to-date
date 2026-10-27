# Documentation Architecture

Documentation registry and index for the Always Up To Date project. This file maps all context documents across the 3-tier system.

## 3-Tier Documentation System

| Tier | Scope | Location |
|------|-------|----------|
| 1 - Foundational | Project-wide overview, dev commands, architecture summary | `/CLAUDE.md` |
| 2 - Component-Level | Component purpose, patterns, integration points | `src/{component}/CLAUDE.md` |
| 3 - Feature-Specific | Granular feature implementation details | `src/{component}/{feature}/CLAUDE.md` |

## Documentation Registry

### Tier 1 (Foundational)

| Document | Path | Description |
|----------|------|-------------|
| Project Overview | `/CLAUDE.md` | Dev commands, architecture, conventions, engine requirements |
| Documentation Index | `.claude/context/ai-context/docs-overview.md` | This file - maps all documentation |

### Tier 2 (Component-Level)

| Component | Path | Description |
|-----------|------|-------------|
| Package Managers | `src/managers/CLAUDE.md` | Manager abstraction, CommandRunner, detection, workspace support |
| CLI Commands | `src/commands/CLAUDE.md` | Commander.js setup, command registration, binary aliases |
| Utilities | `src/utils/CLAUDE.md` | Config system, update logic, logging, file ops, package grouping |
| Migrator | `src/migrator/CLAUDE.md` | Framework migration rules (stub) |
| PR Generator | `src/prGenerator/CLAUDE.md` | Automated PR creation (stub) |

### Tier 3 (Feature-Specific)

No Tier 3 documents yet. As features grow in complexity, add `CLAUDE.md` files in subdirectories (e.g., `src/managers/npm/CLAUDE.md`).

## Project Structure

```
src/
  index.ts                  # Entry point (shebang, calls cli)
  cli.ts                    # Commander.js program setup, registers commands
  types.ts                  # Core types: SupportedPackageManager, PackageInfo, UpdateResult, AlwaysUpToDateConfig, CooldownConfig, RegistryConfig
  commandRunner.ts          # runCommand(pm, args, cwd, isSuccess?) via runProcess; runStep() tags failures
  project.ts                # openProject(cwd, { pm? }): loads the config once, configures the logger, detects the manager → Project (with a lazy registry session)
  discovery.ts              # discoverFromRegistry(): native discovery for npm, pnpm, yarn v1, bun (manifests, node_modules, registry reader)
  pipeline.ts               # check / plan / update (take a Project): detect → discover → plan → apply → report for any adapter
  detectPackageManager.ts   # --pm, then packageManager, then devEngines.packageManager, then the adapters' lockfiles
  stepError.ts              # StepError: failed pipeline step (detect/discover/apply) + manifestWritten
  commands/                 # CLI command definitions
    CLAUDE.md
  managers/                 # One adapter per package manager (adapter.ts interface, index.ts registry)
    CLAUDE.md
  utils/                    # Shared utilities
    CLAUDE.md
  migrator/                 # Framework migration (stub)
    CLAUDE.md
  prGenerator/              # PR automation (stub)
    CLAUDE.md
schema/
  config.schema.json        # JSON schema for .always-up-to-date.json (referenced via $schema)
testRepos/                  # Integration fixtures, <manager>-<layout> (README.md); lockfiles are generated in temp copies, never committed
bench/                      # pnpm run bench: pinned/ and ranges/ (the 40-dependency benchmark manifests), run.ts (copy, install, hyperfine, table), targets.ts (selection, cold caches), report.ts (hyperfine JSON parsing, table), register.cjs (swc loader for run.ts)
jest.integration.config.ts  # Jest config for the integration matrix (not part of pnpm test)
__tests__/
  integration/              # pnpm run test:integration: harness.ts (copy, pin to minimum, install, run the CLI), lockfiles.ts (yarn v1/berry/bun rewriters), expectations.ts (derived values, per-manager overrides), matrix.ts, <manager>.test.ts
  bench/                    # report.test.ts (hyperfine 2 JSON parsing, formatting, table), targets.test.ts (selection, cold caches)
  setup.ts                  # Global test setup (console suppression, AUTD_NO_CACHE=1)
  index.test.ts             # CLI entry: a failure to start prints and exits 1
  cli.test.ts               # Loading the CLI reads no config
  project.test.ts           # openProject: config loaded once, logger configured before detection
  discovery.test.ts         # Native discovery on registry captures: no subprocess, skipped specs, links, missing, failed lookups, #95
  projectRegistry.test.ts   # Real openProject on temp workspaces: a pnpm or bun member reads the workspace root's registry files; a pnpm member with its own yaml is its own root; a yarn v1 .yarnrc routes the default and a scope (#120) and a berry project's is ignored
  pipeline.test.ts          # The pipeline plans with project.config and never loads it; reports a package the manager left in place; npm workspace rows
  singlePackageJson.test.ts # Snapshot of single-package check/plan/update JSON (registry captures as of the capture date plus a written node_modules), identical for all four managers; reviewed once for #106: never update it to make a change pass
  commandRunner.test.ts     # Success checks, stderr-at-debug, failure messages
  commands/
    check.test.ts, help.test.ts, init.test.ts, update.test.ts  # Command registration and options
    jsonOutput.test.ts      # Real logger: stdout is exactly one JSON document with --json
    failures.test.ts        # Failed steps and a malformed config: exit code 1, one message, JSON error object
    registryPathToken.test.ts # A token in a registry URL path never reaches a message: the client's errors, a fake npm's stderr, debug lines and the --json error object (#131)
  detectPackageManager.test.ts  # Detection order on real temp dirs: --pm, packageManager, devEngines, lockfiles; stray-lockfile logging
  startup.test.ts           # Loading the CLI never loads the registry client or reader
  fixtures/
    registry.ts, tls/       # Local registry/proxy servers (replies() for exact url tables, registryBody() which gunzips a .body.gz, derive()); test-only TLS material (generate.sh)
    registry/               # Verbatim curl captures (.body; .body.gz over 100 KB decoded) of dist-tags, deps.dev and packuments: ms, @types/ms, mkdirp, then yarn, pnpm, dayjs, debug, express, semver, zod, axios, lodash, next, qs, typescript for #106 (packuments only for yarn and pnpm); README.md lists status, type, wire and decoded size and the checks
    index.ts                # readFixture(), exitError(), fakeRegistry(), projectFor(), writeWorkspaceProject(), WORKSPACE_ENTRIES helpers; capturedPackage(name, { source, asOf }) and capturedRegistry(names, options) build RegistryPackage / a session from the captures, installPackages(cwd, dir, versions) writes node_modules, readRegistryBody() and derive() are re-exported from registry.ts
    captured.test.ts        # The captured-registry helpers: sources, asOf, latest fallback, unplanned names, installPackages
    npm/ pnpm/ yarn/        # Real captured manager stdout/stderr: apply commands and errors (pnpm update, yarn v1 update/upgrade, yarn berry info), npm's package-lock.json for #107
  managers/
    adapters.test.ts        # Registry: adapterFor(name), one lockfile per manager
    npm.test.ts, pnpm.test.ts  # npm: readLockedVersions on package-lock.json (for #107); pnpm: readWorkspace (workspace detection, catalog records, CRLF), single-package update paths, member map
    yarn.test.ts            # yarn v1: upgrade descriptors, v1-over-stray-.yarnrc.yml, stderr warning at debug level, failed apply
    yarnBerry.test.ts       # yarn berry on real captures (PnP, node-modules, workspace, patch:/alias/link): parsers, discovery, in-range and beyond-range apply, installed-version check
    realSubprocess.test.ts  # Fake npm on PATH (sh wrapper / cmd-shim, all platforms): >1 MB output, names passed as arguments
    reuseDiscovery.test.ts  # update with a discovery result applies without discovering again (the throwing fake registry proves no lookup)
    withinRange.test.ts     # Native discovery on registry captures, default config: proposes exactly npm update's set; zero for pins
    applyRanges.test.ts     # In-range apply writes nothing; beyond-range writes the target spec first
    aliases.test.ts         # An npm: alias on all four managers: manifest key, looked up by the target, never by the key
    pnpmRegistries.test.ts  # pnpm yaml registry routes: both shapes, scopes, "@", ${…}, ecosystem, CRLF; env expansion for the global file; substitutePnpm
    pnpmNpmrc.test.ts       # pnpm 12 layers on temp dirs: #117 evidence rows, one test per probe decision (p20-p55), config directory per platform (Linux and Windows source-read), workspace members, `fetchTimeout` / `fetchRetries` from yaml and env only (#125)
    yarnNpmrc.test.ts       # yarn v1 .npmrc layers on temp dirs: #122 evidence rows, the comment's example, one test per probe decision (y20-y32), the filesystem root, berry keeps npm's
    yarnrc.test.ts          # yarn v1 .yarnrc grammar (quotes, comments, CRLF, --registry), routes, precedence against .npmrc, env and ~/.yarnrc, workspace parents
    bunNpmrc.test.ts        # bun's .npmrc layers on temp dirs: project, one user file (XDG, userconfig), no env/prefix/parent, $VAR forms
    bunfig.test.ts          # bunfig.toml routes and credentials, $NAME, global/project merge, env overrides, bunfigExact
    stepFailures.test.ts    # Each manager rejects with a discover/apply StepError
    workspaces.test.ts      # Member map: workspace patterns, negations, skips
    workspaceDiscovery.test.ts  # Workspace check on all four managers (native) returns one record; unnamed roots
    workspaceApply.test.ts  # Workspace apply per manager: commands, member manifest writes, catalog routing
  utils/
    config.test.ts          # Config loading/saving tests (incl. cooldown variants, strict depsDev)
    cooldown.test.ts        # Normalize/evaluate cooldown gate
    duration.test.ts        # parseDuration + formatAgeDays
    files.test.ts           # File operations and version parsing tests; readPnpmCatalogs / readBunCatalogs and their agreement with the pnpm writer
    filterPackages.test.ts  # Package filtering, targeting, cooldown integration
    logger.test.ts          # Logger output, configure(), quiet and JSON output modes
    npmrc.test.ts           # .npmrc parser: cases ported from ini 7, npm's ${VAR} substitution
    npmrcLayers.test.ts     # mergeNpmrcLayers (per key, origin), envLayer rules, npmrcFileLayer (substitute null leaves out ${…}), npmNpmrcLayers order and merge
    npmrcLoader.test.ts     # Layering (global, user, project, npm_config_*), workspace root, RegistryConfig, on temp dirs
    registryRequest.test.ts # Pure client helpers: scoped registry, prefix walk, Authorization forms, retry rules, public-registry check, dist-tags and deps.dev URLs, package-name rule
    registryClient.test.ts  # node:https client against local HTTP(S) servers and a CONNECT proxy: auth, TLS, mTLS, proxies, retries, timeout, maxsockets, redirects, per-request accept/timeout/retries, stats()
    registry.test.ts        # createRegistrySession: lazy config and client, one per run, in-flight dedupe, fails open, scoped registry (#104), close(), lookup() sharing the client and honoring depsDev
    registryReader.test.ts  # createRegistryReader on captured bodies and local servers: deps.dev path, packument fallbacks, breaker, depsDev: false, other registries, credentials, 404s, failures, dedupe, bounded concurrency; with the disk cache: TTLs, 304 revalidation, Q1 (authenticated answers), Cache-Control, no stale fallback, unwritable folder
    registryCache.test.ts   # The store: cacheDirectory per platform, endpointKey, freshFor, round trips, misses, atomic writes across processes, pruning, fails open, modes
    registryDocuments.test.ts # dist-tags, deps.dev and packument parsers on the fixtures; the sources agree; malformed input
    limiter.test.ts         # createLimiter: peak, FIFO, rejection frees the slot
    packageGrouper.test.ts  # Package grouping tests
    runProcess.test.ts      # Real child processes: no output cap, no shell, Windows quoting
    updateChecker.test.ts   # Update policy: within range, beyondRange levels, rules, legacy mapping
    overrides.test.ts       # Which override keys pin a package, per manager's current version
    peers.test.ts           # Installed peer ranges from hoisted node_modules and the pnpm store
    saveStyle.test.ts       # Where each manager keeps save-exact / save-prefix
    workspaceRows.test.ts   # foldWorkspaceEntries ordering and top-level choice
    installed.test.ts       # Installed root-dependency versions (hoisted, scoped, alias, pnpm symlink); readInstalledPackages linked detection (junction to a member, pnpm store link, link outside the project); checkApplied
    wanted.test.ts          # wantedVersion on the yarn and pnpm captures, each on deps.dev and on the packument
    dependencySpecs.test.ts # classifySpec table; readDeclaredDependencies on temp dirs (field order, peers, catalogs, members, unreadable manifest)
    aliasSpec.test.ts       # parseAlias / parseBareAlias (`npm:` specs) and isRecord
    rows.test.ts            # Display rows: the in-range note is left out when wanted fell back to current
```

## Tech Stack

- **Language:** TypeScript (ES2020 target, CommonJS output)
- **CLI Framework:** Commander.js
- **Package Manager:** pnpm (>=10.0.0)
- **Node:** ^22.23.0 || >=24.17.0 (`.tool-versions` pins 24.22.1)
- **Testing:** Jest + @swc/jest
- **Linting/Formatting:** Biome
- **Path Aliases:** `@/*` -> `src/*` (resolved by tsc-alias at build)
- **Key Dependencies:** semver, colorette, @inquirer/prompts (registry metadata for cooldown comes from our own `node:https` client and `.npmrc` parser, no dependency)
