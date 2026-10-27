# Roadmap: performance, correctness and portability

Status: proposed 2026-10-23 from an analysis of v1.0.31. M0 and M1 done and closed 2026-10-23,
released as 2.0.0. M2 done and closed 2026-10-23, released as 2.1.0 on 2026-10-24. M3 planned
2026-10-26 from a new baseline on 2.1.0; next.

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

| Path                                 | Direct `<pm> outdated` | `autd check`                              |
| ------------------------------------ | ---------------------- | ----------------------------------------- |
| npm                                  | 0.84 s                 | 0.92 s                                    |
| pnpm                                 | 1.03 s                 | 0.97 s                                    |
| yarn v1                              | 2.59 s                 | 2.71 s, and reports nothing (see defects) |
| bun                                  | 0.02 s                 | 0.14 s                                    |
| Native prototype, dist-tags endpoint | 0.6 s cold, 5 KB total | n/a                                       |
| Cooldown on today                    | adds 2.3 s and ~67 MB  | no disk cache                             |

Startup: bare Node 30 ms, autd 102 ms, of which 48 ms is eager-loading the registry
client and its 171 modules. Bundled to one file: 89 ms. Bun-compiled binary after
re-signing: 47 ms, 62 MB. Node SEA: 65 ms, 117 MB.

### M3 baseline (2.1.0)

Measured 2026-10-26 on autd 2.1.0 (31bdb10), Node 24.22.1, macOS, on the 40-dependency
benchmark, now `bench/pinned/` and run by `pnpm run bench` (rebuilt from
an earlier npm `outdated` capture: every dependency pinned to its old exact version).
Bun has since moved to 1.4.4: warm 0.17 s, cold 22.5 s ± 7.5 over 2 runs. Registry traffic on this machine passes through an endpoint TLS proxy
(Aikido), so absolute network times are indicative. "Cold" empties the manager's own cache.

| Manager                                  | `autd check`, warm | `autd check`, cold | Peak memory |
| ---------------------------------------- | ------------------ | ------------------ | ----------- |
| npm 11.19.1                              | 0.92 s             | 1.53 s             | 347 MB      |
| pnpm 12.14.0                             | 0.25 s             | 1.88 s             | 85 MB       |
| yarn 1.22.22                             | 2.65 s             | 3.17 s             | 756 MB      |
| bun 1.4.0                                | 0.16 s             | 14.8 s             | 89 MB       |
| yarn 4.12.0 (berry, node-modules linker) | 8.5 s              | 9.5 s              | 802 MB      |
| yarn 4.12.0 (berry, PnP, yarn's default) | 9.4 s              | 10.1 s             | 793 MB      |
- The yarn, bun and berry memory figures, berry's cold times and the PnP row come from the first
  `pnpm run bench` (hyperfine, 5 warm and 3 cold runs). Berry keeps no registry metadata cache
  (its global folder holds only package zips), so its cold and warm times differ only by noise.
- Startup: bare `node -e 0` 39 to 41 ms, `autd --version` 126 ms, 215 modules loaded, most of
  them npm-registry-fetch's. Bundled with the registry client stubbed out: 60 ms (57 ms with
  Node's compile cache), 21 ms over bare Node.
- Cooldown at 7 days: `check` on pnpm goes from 0.23 s to 2.54 s and from 85 MB to 600 MB peak
  memory. It parses 146 MB of full packuments for the 40 packages.
- Registry payloads for the 40: dist-tags 5.1 KB (0.69 s); abbreviated packuments 53 MB decoded,
  about 16 s (next alone 25.7 MB, typescript 8.8 MB); deps.dev GetPackage about 10 KB per
  package gzipped (next 43.5 KB). Bun's cold `outdated` downloads the abbreviated packuments,
  which is its 14.8 s.

## Milestones

Sizes are rough. Order matters more than dates.

### M0: Correctness floor (small, done)

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

### M1: Respect the manifest (medium, done)

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

### M2: One Node ecosystem (medium, done)

Goal: adding a manager is one adapter file plus fixtures.

- Collapse the four classes into the shared pipeline. A manager adapter holds only
  command strings, a parser, the apply command and manifest writers.
- Detect the manager from the `packageManager` or `devEngines` field first, lockfile
  second, with a `--pm` flag to override.
- Add yarn berry (no `outdated`; discovery comes from the pipeline, apply uses `up`).
- Integration matrix in CI: generate lockfiles for `testRepos/` and run `check --json`
  across npm, pnpm, yarn and bun, single, workspace and catalog layouts. Done as
  `pnpm run test:integration`, run per manager on ubuntu and windows.
- Direct unit tests for every parser.

Done when: a new manager needs no changes outside its adapter and fixtures.

### M3: Native discovery and cache (large, the speed milestone)

Goal: `check` is fast on every manager and no longer depends on `<pm> outdated`.

- Read manifests including workspaces and catalogs (writers already exist in
  `src/utils/files.ts`); read installed versions from node_modules, and from `yarn.lock` or
  `package-lock.json` where there is none (yarn berry's PnP, an npm workspace never installed).
- Public npm names: `latest` from the dist-tags endpoint; the version list, deprecation and
  publish times from one deps.dev GetPackage call per package (about 10 KB, against 0.3 to
  25 MB for the abbreviated packument). Only names served by registry.npmjs.org go to deps.dev,
  and a config switch turns it off.
- Other registries, and public names deps.dev has not caught up with (`latest` missing from its
  list): the abbreviated packument, revalidated by ETag. Publish times from its `time` when the
  registry includes it, else the full packument, fetched only for candidates that pass policy.
  A version with no known publish time is fetched, not let through.
- When the packument and the dist-tags disagree, the packument wins: security proxies remove
  fresh versions from the packument but leave the dist-tags endpoint alone.
- `wanted`: an exact pin is its own; else `latest` when it satisfies the range and is not
  deprecated; else the highest satisfying non-deprecated version. Yarn berry does not prefer
  the `latest` tag, so its adapter turns that step off. Every other manager gets this rule.
- A small disk cache under the user cache dir, in a folder named `ca.pixel-perfect.alwaysuptodate`
  (`~/Library/Caches/…` on macOS, `$XDG_CACHE_HOME/…` on Linux, `%LOCALAPPDATA%\…` on Windows).
  It holds derived values only, never whole packuments, with a size cap: dist-tags for 300 s,
  deps.dev answers for an hour, ETags for revalidation. Bounded concurrency.
- Drop npm-registry-fetch and ini for a `node:https` client with one keep-alive agent per
  registry, honoring `.npmrc` auth, client certificates, CA, `strict-ssl`, proxies and retries.
  Lower the Node floor to `^22.23.0 || >=24.17.0` (agent proxy support plus the CVE-2026-48615
  fix); native `fetch` can't do per-registry client certificates or CA, and the undici
  package costs 44 ms at startup. Bundle to one file.
- The package manager is used only for apply.

Done when the perf gates below pass in CI, `check` runs no `<pm> outdated` or `yarn info`, and
the integration matrix passes unchanged.

### M4: Policy signals (medium)

Goal: risky updates are flagged in the plan, never applied silently.

- Per-version registry document (2 to 4 KB) for candidates only: license change,
  deprecation, engines versus the project's engines and current Node. npm's own `wanted` also
  skips versions whose engines exclude the running Node; M3's native `wanted` doesn't yet.
- Peer-conflict pre-check against installed packages: done in M1 (`src/utils/peers.ts`).
- Honor pnpm's native minimum release age when present.
- Versioned `--json` schema with reasons on every row.

Done when: a major bump that violates an installed peer range or changes license is
reported with a reason and skipped unless explicitly allowed.

### M5: Portability and distribution (small, plus validation)

Goal: a machine without Node can run autd.

- Bundled npm package with few runtime dependencies.
- Standalone binaries via `bun build --compile`, re-signed after build (Bun 1.4.0 emits
  an invalid ad-hoc signature on arm64 macOS; `codesign --force --sign -` fixes it, a
  Developer ID is used for release and notarization). The signing identifier is
  `ca.pixel-perfect.alwaysuptodate`, the scheme env-router uses (`ca.pixel-perfect.envrouter`),
  and the same name M3's cache folder takes.
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

| Metric                           | Budget                                               |
| -------------------------------- | ---------------------------------------------------- |
| `check`, cold cache, any manager | under 1 s                                            |
| `check`, warm cache              | under 0.3 s                                          |
| Startup (`--version`)            | under 25 ms over bare `node -e 0` on the same runner |
| Cooldown overhead, cold          | under 0.5 s                                          |

The startup budget was "under 60 ms" until 2026-10-26. Bare Node alone measured 30 ms on
2026-10-22 and 39 to 41 ms on 2026-10-26 on the same machine, so an absolute number measured
the runner more than autd.

## Defects found during the analysis

| Defect                                                                    | Milestone | Issue |
| ------------------------------------------------------------------------- | --------- | ----- |
| Exact pins rewritten to caret ranges (`decorator \|\| '^'` in files.ts)   | M0        | #35   |
| `wanted` discarded by all four parsers                                    | M1        | #43   |
| yarn v1 broken on Node 24: stderr warning treated as failure              | M0        | #36   |
| `yarn update` is not a yarn command                                       | M0        | #37   |
| Shell `exec` with 1 MB output cap; names interpolated into a shell string | M0        | #38   |
| Interactive mode runs `outdated` twice                                    | M0        | #39   |
| `update --json` prints 48 logger lines before the JSON                    | M0        | #40   |
| Coverage ignores every `index.ts`, 787 of 2500 lines incl. all managers   | M0        | #41   |
| CI never runs Biome and never runs on pull requests                       | M0        | #42   |
| No test exercises real manager output; testRepos lack lockfiles           | M2        | #44   |
| Node 24 floor imposed only by npm-registry-fetch and ini                  | M3        | #46   |
| Cooldown fetches full packuments, unbounded concurrency, no cache         | M3        | #47   |
| Config loaded at module import time in updateChecker, ignores cwd         | M2        | #45   |
| pnpm workspace rows that share a version get one owner's `wanted`         | M3        | #95   |

## M3 issues

Filed 2026-10-26, in pick-up order.

| Gap or defect                                                                           | Milestone | Issue |
| --------------------------------------------------------------------------------------- | --------- | ----- |
| The benchmark the perf gates measure is not in the repository                           | M3        | #103  |
| Node >=24 floor and the npm-registry-fetch / ini client (`node:https` replacement)      | M3        | #46   |
| Cooldown ignores scoped registries, `strict-ssl` and `cafile` (2.1.0 bug, fixed by #46) | M3        | #104  |
| No registry reader of its own: `latest`, versions, deprecation, publish times           | M3        | #105  |
| `check` runs `<pm> outdated`: native discovery for npm, pnpm, yarn v1, bun              | M3        | #106  |
| Discovery without `node_modules`: installed versions from the lockfile (berry, npm)     | M3        | #107  |
| Registry lookups repeat on every run: cache under `ca.pixel-perfect.alwaysuptodate`     | M3        | #108  |
| Cooldown fetches full packuments, unbounded concurrency, no cache                       | M3        | #47   |
| Startup loads the whole CLI: bundle to one file                                         | M3        | #109  |
| Perf budgets are not enforced in CI                                                     | M3        | #110  |
