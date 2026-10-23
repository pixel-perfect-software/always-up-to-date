# Roadmap: performance, correctness and portability

Status: proposed 2026-10-23 from an analysis of v1.0.31. Not started.

Tracking: GitHub milestones M0 through M6 at
https://github.com/pixel-perfect-software/always-up-to-date/milestones. Pull requests
should be assigned to the milestone they advance.

## Decision

Stay in TypeScript. The measured slowness is architectural: the package-manager
subprocess dominates wall time, cooldown mode downloads full packuments with no cache,
the four managers are near-identical copies, and the range-respecting `wanted` value
every manager already returns is discarded. A language port would fix none of that.

The plan: honor the manifest's own version intent by default, collapse the managers
into one Node ecosystem adapter behind a single pipeline, replace shell-out discovery
with native registry queries and a disk cache, then ship standalone binaries.
A port to Rust or Go is re-evaluated only at the M6 gate.

## Principles

1. `package.json` is the policy source. `.always-up-to-date.json` is an override layer
   people reach for only when they want more than the manifest allows.
2. The package manager owns apply (install, lockfile). autd owns discovery, policy and
   planning. autd never tries to out-do the manager at lockfile generation.
3. Respect what managers enforce: exact pins, `^`/`~` ranges, overrides and resolutions,
   peer ranges, engines, `save-exact`/`save-prefix`, catalogs and workspace protocol.
4. One pipeline for every manager and ecosystem:
   detect -> discover -> resolve -> classify -> plan -> apply -> report.
5. Fail open on network problems, never on correctness.
6. Performance is a tested property, enforced by perf gates in CI.

## Baseline

Measured 2026-10-22 on a 40-dependency benchmark project with all 40 outdated,
Node 24, macOS, warm runs.

| Path | Direct `<pm> outdated` | `autd check` |
|---|---|---|
| npm | 0.84 s | 0.92 s |
| pnpm | 1.03 s | 0.97 s |
| yarn v1 | 2.59 s | 2.71 s, and reports nothing (see defects) |
| bun | 0.02 s | 0.14 s |
| Native prototype, dist-tags endpoint | 0.6 s cold, 5 KB total | n/a |
| Cooldown on today | adds 2.3 s and ~67 MB | no disk cache |

Startup: bare Node 30 ms, autd 102 ms, of which 48 ms is eager-loading the registry
client and its 171 modules. Bundled to one file: 89 ms. Bun-compiled binary after
re-signing: 47 ms, 62 MB. Node SEA: 65 ms, 117 MB.

## Milestones

Sizes are rough. Order matters more than dates.

### M0: Correctness floor (small)

Goal: stop doing things that break trust.

- Never add a decorator the manifest did not have. An exact pin stays exact.
- Accept subprocess output when the exit code and stdout parse, even if stderr has
  warnings (yarn v1 on Node 24 prints a deprecation warning to stderr).
- Use the real yarn commands: `upgrade` on v1, `up` on berry.
- Replace shell `exec` with `execFile` and an argument array, no output cap.
- Interactive mode reuses the first discovery result instead of running `outdated` twice.
- `--json` is pure JSON on every command.
- Coverage config stops ignoring every `index.ts`; the four managers become measured.
- CI runs on pull requests and runs Biome.

Done when: a pinned dependency is untouched under the default config, `autd check`
works on yarn v1 under Node 24, and 1.5 MB of subprocess output does not crash.

### M1: Respect the manifest (medium)

Goal: the default run proposes exactly what the package manager itself would apply.

- Carry `wanted` through the pipeline for every manager.
- Default policy is "within range". Exact pin means hold.
- The config becomes an override layer: allow beyond-range updates globally or per
  package, with `hold`, `followRange` and `latest` rules.
- Read `save-exact` and `save-prefix` from `.npmrc` when a decorator must be chosen.
- Skip and report packages controlled by `overrides`, `resolutions` or `pnpm.overrides`.
- Pre-check installed peer ranges before proposing a major; the data is in node_modules.

Done when: on the benchmark project the default run proposes zero changes to pinned
dependencies and the same set `npm update` would apply.

### M2: One Node ecosystem (medium)

Goal: adding a manager is one adapter file plus fixtures.

- Collapse the four classes into the shared pipeline. A manager adapter holds only
  command strings, a parser, the apply command and manifest writers.
- Detect the manager from the `packageManager` or `devEngines` field first, lockfile
  second, with a `--pm` flag to override.
- Add yarn berry (no `outdated`; discovery comes from the pipeline, apply uses `up`).
- Integration matrix in CI: generate lockfiles for `testRepos/` and run `check --json`
  across npm, pnpm, yarn and bun, single, workspace and catalog layouts.
- Direct unit tests for every parser.

Done when: a new manager needs no changes outside its adapter and fixtures.

### M3: Native discovery and cache (large, the speed milestone)

Goal: `check` is fast on every manager and no longer depends on `<pm> outdated`.

- Read manifests including workspaces and catalogs (writers already exist in
  `src/utils/files.ts`); read installed versions from node_modules.
- Resolve latest through the dist-tags endpoint; fall back to the abbreviated packument
  per registry host when the endpoint is missing.
- Publish times from a cached per-package time map: deps.dev as the public fast path,
  full packument as fallback, fetched only for candidates that pass policy.
- ETag disk cache under the user cache dir, bounded concurrency.
- Drop the heavy registry client and the ini dependency; bundle to one file; lower the
  Node floor to 20 or 22.
- The package manager is used only for apply.

Done when the perf gates below pass in CI.

### M4: Policy signals (medium)

Goal: risky updates are flagged in the plan, never applied silently.

- Per-version registry document (2 to 4 KB) for candidates only: license change,
  deprecation, engines versus the project's engines and current Node.
- Peer-conflict pre-check against installed packages.
- Honor pnpm's native minimum release age when present.
- Versioned `--json` schema with reasons on every row.

Done when: a major bump that violates an installed peer range or changes license is
reported with a reason and skipped unless explicitly allowed.

### M5: Portability and distribution (small, plus validation)

Goal: a machine without Node can run autd.

- Bundled npm package with few runtime dependencies.
- Standalone binaries via `bun build --compile`, re-signed after build (Bun 1.4.0 emits
  an invalid ad-hoc signature on arm64 macOS; `codesign --force --sign -` fixes it, a
  Developer ID is used for release and notarization).
- Release workflow builds macOS arm64 and x64, Linux and Windows, signs each, attaches
  them to GitHub releases. Homebrew tap formula downloads the matching asset.
- The test suite and integration matrix also run against the compiled binary, since it
  runs on Bun's runtime rather than Node.

Done when: `autd check` runs on a bun project on a machine with no Node installed.

### M6: Second ecosystem and the language gate (medium)

Goal: prove the pipeline is ecosystem-agnostic, then decide about a port with data.

- Add one datasource and manager pair. Candidates: Python via PyPI (its JSON API has
  per-release upload times, so cooldown works natively) or Cargo via the sparse index.
- Decision gate: only after M6, if binary size or no-runtime distribution are still
  blockers, consider a port. The pipeline and fixture matrix are the spec by then, so a
  port is a translation, not a redesign. Rust for size and startup; Go if cross-ecosystem
  lockfile parsing dominates, since syft and grype already parse every format in Go.

## Perf gates (land with M3)

Run hyperfine against the benchmark project on every pull request and fail above budget:

| Metric | Budget |
|---|---|
| `check`, cold cache, any manager | under 1 s |
| `check`, warm cache | under 0.3 s |
| Startup (`--version`) | under 60 ms |
| Cooldown overhead, cold | under 0.5 s |

## Defects found during the analysis

| Defect | Milestone | Issue |
|---|---|---|
| Exact pins rewritten to caret ranges (`decorator \|\| '^'` in files.ts) | M0 | #35 |
| `wanted` discarded by all four parsers | M1 | #43 |
| yarn v1 broken on Node 24: stderr warning treated as failure | M0 | #36 |
| `yarn update` is not a yarn command | M0 | #37 |
| Shell `exec` with 1 MB output cap; names interpolated into a shell string | M0 | #38 |
| Interactive mode runs `outdated` twice | M0 | #39 |
| `update --json` prints 48 logger lines before the JSON | M0 | #40 |
| Coverage ignores every `index.ts`, 787 of 2500 lines incl. all managers | M0 | #41 |
| CI never runs Biome and never runs on pull requests | M0 | #42 |
| No test exercises real manager output; testRepos lack lockfiles | M2 | #44 |
| Node 24 floor imposed only by npm-registry-fetch and ini | M3 | #46 |
| Cooldown fetches full packuments, unbounded concurrency, no cache | M3 | #47 |
| Config loaded at module import time in updateChecker, ignores cwd | M2 | #45 |
