# Session Handoff

**Updated:** 2026-11-03
**Branch:** main · **Last commit:** dd34d03 Merge pull request #163 from pixel-perfect-software/fix/127-yarn-v1-member-registry

## Where things stand

The user merged two yarn v1 fixes from M3 to `main` on 2026-11-03, and the issues closed:
- **PR #162 (#126):** yarn v1 registry credentials follow yarn's rule.
- **PR #163 (#127):** yarn v1 member moves resolve at the root.

Both PRs had all 14 CI checks green; CI on `main` at dd34d03 is green: the CI run (41667392167) and the Security run (41667391810) both succeeded. Nothing is released since 3.3.0, which is confirmed as npm `latest` (`{"latest":"3.3.0"}`, 2026-11-03).

Verified before the merges, on 2026-11-03:
- **fix/127 at 67036a7:** `check-types` passes, `format-and-lint` passes (238 files), and `pnpm test` passes 1653 tests, 1 skipped, 74 suites. It was run without the sandbox's proxy variables.
- **Both branches merged locally:** 1684 tests passed.

## In progress

Nothing. The local fix/126 and fix/127 branches are deleted. Their remote branches are still on GitHub, because the repo doesn't auto-delete head branches. The stale `autd-main` worktree was pruned.

## Decisions made this session

- **#127: resolve yarn v1 member moves at the root** (the user, 2026-11-03). This replaces the issue's own direction, member-specific lookups. Memory: `project_127_root_resolution.md`.
  - Evidence: `yarn workspace <m> upgrade` runs in the member's directory, where `~/.npmrc` outranks the root's `.npmrc` (probes m1–m4). A root `install`, `outdated` and `upgrade-interactive` all use the root's.
  - Member rows now go through `applyPinned` (`ManagerAdapter.pinMembers`, `splitUpdates({ pinMembers })`). This removes #123's per-member `upgrade`, the `-D` / `-O` restore and `install --check-files`.
- **The registry view loads at the project root for every manager** (`src/project.ts`, `loadConfig: () => managerRegistryConfig(adapter, root, …)`). Only yarn v1 changes: npm, pnpm and bun already read the root's files from a member. The session itself keeps the cwd, for a relative `AUTD_CACHE_DIR`.
- **`rewriteYarnV1Lock` moves a restored range off any other entry**, and drops an entry left with no keys. Without that, a member range shared with a transitive requester kept the old version: a real run reported it `not applied`.
- **#126 mirrors yarn's whole `NpmRegistry` credential rule**, not just the issue's two points:
  - lookup by the route (`yarnV1RegistryKeys`: the route, without its protocol, then without `registry/`; no walk up the path);
  - `https://host/:` keys;
  - each field falling back to its bare key;
  - yarn's own default registry also taking npm's credentials;
  - on a redirect, the header kept on the same hostname and dropped on another.
  - On c19 (an unset `${VAR}` token; yarn aborts) autd drops the key and the bare `_authToken` stands in. Documented in `src/utils/CLAUDE.md`.

## Known issues / blockers

- **Sandbox-only failures** (memory `reference_sandbox_known_failures.md`):
  - With the proxy variables set, `project.test.ts` fails. Run the suite under `env -u HTTPS_PROXY -u HTTP_PROXY -u https_proxy -u http_proxy -u NO_PROXY -u no_proxy`.
  - The yarn v1 integration matrix fails locally with `Received malformed response from registry`, so CI is the check there.
  - `gh run view --log` needs a host the sandbox and auto mode refuse. The jobs API (`gh api …/actions/jobs/<id>`) works for step results.
- **Real yarn runs against local registries work** in the sandbox. The probe scripts are in this session's scratchpad (`/private/tmp/claude-501/-Users-tylerrobertson-personal-dev-always-up-to-date/56ac52c6-4480-41be-b075-71d388ee712c/scratchpad/probe126/`, may not survive a reboot):
  - `server.js` / `server2.js` serve logging registries, with real per-version tarballs from `server2.js`.
  - `probe-yarn.sh` and `probe-autd.sh` run the 20 auth cases.
  - `probe127.sh` checks the member upgrade's view.
  - `probe127-apply.sh` runs a full workspace update with `CLI=` and `CONFIG=`.
  - Pitfalls found:
    - Homebrew's `yarn` wrapper fails in temp directories under asdf ("No version is set for command node"). Put a shim that runs `~/.asdf/installs/nodejs/24.22.1/bin/node …/yarn.js` first on PATH.
    - PATH holds spaces (`Application Support`), so build a minimal PATH.
    - `upgrade` needs a lockfile: run `install` first.
    - Processes started with `&` in an earlier command can't be killed later. PID 20436 still holds 127.0.0.1:4871, so use other ports.
- **Force-push is blocked by auto mode.** So #163 merged with its docs-only second commit (67036a7).
- **Commits sign from Claude's shell now** (the 1Password socket is allowed). `git push` works, but writing `.git/config` (upstream tracking) fails harmlessly.
- **Outside PRs to decide:**
  - #157 (an outside contributor) duplicates #155's fix, which shipped in 3.3.0. Close it with thanks, or ask them to rebase.
  - #160 is a Dependabot bump of biome 2.6.3 → 2.6.4.
- **Carried:**
  - Code-review findings 4, 9 and 10 from #123 are not fixed, for the reasons given there.
  - The `openProject` re-detection branch is untested.
  - `src/utils/CLAUDE.md` is over the Tier 2 line cap, and longer now.
  - `docs-overview.md` still lacks `__tests__/fixtures/cacheWriter.ts`, `__tests__/integrationHarness.test.ts`, `__tests__/managers/unusableRegistry.test.ts` and `__tests__/repoConfig.test.ts`.
  - The berry matrix needs Corepack's yarn first on PATH.
  - Real-run snippets need `bash`, not zsh.
  - The Aikido TLS proxy hides same-day versions.
  - Dependabot's npm job fails on `catalog:`. GitHub reports 2 open alerts on `main` (1 moderate, 1 low).

## Next priorities

1. **Decide on a release** (`/ship:release`, the user's call); CI on `main` is green. #126 and #127 fix yarn v1 behavior users hit: tokens sent where yarn sends none, and member lockfile entries resolved from `~/.npmrc`.
2. **#107:** installed versions from the lockfile when `node_modules` is missing, and berry onto native discovery. It is the largest open M3 piece and unblocks the perf gates.
3. **#47** (cooldown on the reader and the cache), then **#109** (bundling) and **#110** (perf gates in CI), which close M3.

## Things I was unsure about

- **yarn's own default registry** (`registry.yarnpkg.com`, then npm's credentials) was read from yarn's source, not run. It needs a request to a public registry with a token.
- **A `--upgrade.registry` flag in a `.yarnrc`** routes `yarn upgrade` (the root's own rows) but not the pin path's `install`. Discovery uses it for every package. Cooldown pins already had this gap; it is now wider.
- **Cost of the pin path on a large yarn v1 workspace:** two root installs replace one upgrade per member plus `--check-files`. Not benchmarked.
- **Loading the view at the root changes relative settings when autd runs from a subdirectory.** A relative `userconfig` or `cafile` now resolves against the root, where the manager runs, rather than the cwd. No test covers a subdirectory run for npm, pnpm or bun.
- **Client certificates under yarn v1:** autd still presents per-registry `certfile` / `keyfile`, which yarn v1 doesn't read.
- **Carried:**
  - whether hyperfine's peak memory counts child processes;
  - whether bun sends `BUN_CONFIG_TOKEN` to registry.npmjs.org when that is the default;
  - what tripped the deps.dev breaker in two runs on 2026-10-26.
