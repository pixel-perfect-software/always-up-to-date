# Session Handoff

**Updated:** 2026-10-30
**Branch:** main · **Last commit:** dbd399c Merge pull request #159 from pixel-perfect-software/release-3.3.0

## Where things stand

**3.3.0 is released** (2026-10-30). The user pushed tag `v3.3.0` on dbd399c, and `release.yml` run 41116243243 passed. Its log reads `Published package @pixel-perfect-software/always-up-to-date@3.3.0`, with a signed provenance statement, and the GitHub release `v3.3.0` exists. This machine's npm view still showed `latest: 3.2.0` right after the publish, on both the dist-tags endpoint and the packument. That is the Aikido proxy hiding a same-day version, not a failed publish; recheck tomorrow or from another network.

3.3.0 carries:
- #151 and #152 (PRs #153, #154)
- #123: member runs and the yarn v1 `-D` / `-O` fix (PR #156)
- #155: `peerDependencies` is never rewritten (PR #158)

CI on `main` is green, and nothing is in flight: there are no open PRs of ours, and every work branch is deleted.

## In progress

Nothing.

## Decisions made this session

- **Reads from a member, writes from the root** (the user, 2026-10-29). The member apply, the npm reconcile and `alsoMoved` were dropped. No manager scopes a member write:
  - every manager moves other workspaces' locked copies;
  - npm leaves `node_modules` behind its lockfile;
  - yarn v1's `workspace … upgrade` unlinks dependencies;
  - berry's `up` is project-wide.

  Memory: `project_member_scope.md`.
- **yarn v1 workspace apply:**
  - one `upgrade` per manifest, with no field flags;
  - member manifests are restored to their original bytes, then their beyond-range specs are re-written with `updatePackageJson`;
  - the root keeps yarn's own write, so a root-only update writes the same bytes as `main` (checked on a real run);
  - `install --check-files` runs only after a member command.
- **`openProject` re-detects** when `adapter.projectRoot(dir)` differs from `locate`'s root. Detection and the config load run again at the manager's root. A different manager there is a `detect` `StepError`. `locate`'s pnpm signal stops at the nearest `pnpm-workspace.yaml`, as pnpm does.
- **`init` writes to the nearest package.json directory,** which is where `loadConfig` reads.
- **The `peerDependencies` narrowing is not fixed in #123.** It is filed as #155 on M4, with real-run evidence on all five managers. #123's yarn v1 member writes use `updatePackageJson`, so v1 members narrow peers too until #155 lands.

## Known issues / blockers

- **Code-review findings not fixed, with reasons:**
  - **4: an npm member with its own settings-only `pnpm-workspace.yaml`.** This is a rare mixed-manager setup. It fails with a clear "No package manager detected"; `--pm npm` now works there.
  - **9: `packageJsonWorkspaceRoot` and `findNpmProjectRoot`.** `findNpmProjectRoot` is npm's measured `.npmrc` rule, with `node_modules` as a prefix. Merging the two would change one of them.
  - **10: `isYarnBerry`'s repeated ancestor walks.** A handful of filesystem calls at startup, not measured. A memo would need a per-project cache.
- **Not tested:** the branch where `openProject`'s re-detection finds a different manager. No fixture produced the disagreement.
- **Pre-existing doc debt, outside #123:**
  - `src/utils/CLAUDE.md` is 177 lines, over the ~150-line Tier 2 cap; this branch added about 2.
  - `docs-overview.md` does not list `__tests__/fixtures/cacheWriter.ts`, `__tests__/integrationHarness.test.ts`, `__tests__/managers/unusableRegistry.test.ts` or `__tests__/repoConfig.test.ts`. All four exist at 74e4a7a.
- **The berry matrix needs Corepack's yarn first on PATH.** Without it, `yarn` is Homebrew's 1.22.22 and the berry suite fails in `installAtMinimum`. Create shims with `corepack enable --install-directory <dir> yarn`.
- **Real-run snippets need `bash`, not zsh.**
- **The #155 probe captures** are in `/private/tmp/claude-501/autd-peer-probe/`, kept for #155's fix. `/private/tmp` may not survive a reboot.
- **Commits are SSH-signed through 1Password.** A locked agent fails with `error: 1Password: failed to fill whole buffer`. The user commits and pushes.
- **asdf picks node from `.tool-versions`.** Outside the repo, use `~/.asdf/installs/nodejs/24.22.1/bin/node`.
- **Aikido TLS proxy:** it strips fresh versions from packuments, and 403s same-day tarballs, which breaks `bun install` in the bench. Workaround: a `.bunfig.toml` with `[install] minimumReleaseAge = 259200` under `XDG_CONFIG_HOME`.
- **Carried:** Dependabot's npm job fails on `catalog:`; the minimist alerts remain.

## Next priorities

1. **Confirm 3.3.0 on npm** from a network without the Aikido proxy (or tomorrow): `curl -s https://registry.npmjs.org/-/package/@pixel-perfect-software/always-up-to-date/dist-tags` should show `latest: 3.3.0`.
2. **#126:** yarn v1 `always-auth` and a bare `_authToken`.
3. **#127:** yarn v1 per-member upgrade `.npmrc`. Recheck it against the per-manifest `workspace <name> upgrade` apply.
4. **The rest of M3:** #107 (lockfile installed versions, berry onto native discovery), #47 (cooldown on the reader and the cache), #109 (bundling), #110 (perf gates in CI).

## Things I was unsure about

- **The cost of `--check-files` on large yarn v1 workspaces.** It relinks everything, and `pnpm run bench` hasn't measured it.
- **Windows member paths.** CI's matrix on windows-latest is the first run there. The refusal message names an absolute root.
- **Whether #151 and #152 (merged 2026-10-29) need a release before #123.** Not checked.
- **Carried:**
  - whether hyperfine's peak memory counts child processes;
  - whether bun sends `BUN_CONFIG_TOKEN` to registry.npmjs.org when that is the default;
  - what tripped the deps.dev breaker in two runs on 2026-10-26.
