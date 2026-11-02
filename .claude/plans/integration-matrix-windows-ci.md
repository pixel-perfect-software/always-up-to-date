# Integration matrix and Windows CI (#44 + #54)

Issues: #44, #54. Planned 2026-10-23. Branch `feat/44-54-integration-matrix`, stacked on `fix/98-pnpm-install-in-ci` (PR #99). One PR closes both issues; push after each phase, because Windows can only be observed in CI.

- [x] Phase 1: Windows unit CI (#54, part 1)
- [x] Phase 2: Refreshed testRepos, harness, test:integration, Linux matrix (#44)
- [x] Phase 3: Integration matrix on Windows (#54, part 2)

Every phase leaves `pnpm run format-and-lint`, `pnpm run check-types`, `pnpm test` (also `FORCE_COLOR=1 pnpm test`: CI runs with colors on) and `pnpm run build` green. Do not commit, push or switch branches unless the orchestrator says so.

## Decisions (taken by the orchestrator; the user can revisit)

1. testRepos become 12 dirs named `<manager>-<layout>`; every `.always-up-to-date.json` dropped (default config = no file).
2. Manager quirks the matrix observes are asserted as per-manager overrides with a comment.
3. Product bugs the matrix finds: fix in this branch when small (regression unit test); otherwise file an issue (M2, or M5 for Windows-only) and drop that matrix cell with `matrix.exclude` naming the issue. Never `continue-on-error`.
4. Windows jobs are blocking from the first push.
5. `main` has no required status checks (checked 2026-10-23), so renaming the `test` job is safe.
6. Dependabot PR #86 conflicts with the re-pinned workflows: close it after this merges (user).
7. security.yml is pinned too, so a guard can cover every workflow.
8. No beyond-range scenario in the matrix by default. #98 (pnpm frozen install under CI) was found and fixed in PR #99 before this work.
9. npm's version is whatever Node 24.22.1 bundles; a "Show tool versions" step prints it.

## Sources (2026-10-23)

- Jest 30 loads a `.ts` config through Node's type stripping here (ts-node can't drive TypeScript 7), so a config importing another must use the explicit extension: `import base from './jest.config.ts'`. If that fails, make `jest.integration.config.ts` self-contained (testEnvironment, transform, moduleNameMapper, transformIgnorePatterns, setupFiles, extensionsToTreatAsEsm).
- oven-sh/setup-bun v2.2.0 = commit `0c5077e51419868618aeaa5fe8019c62421857d6`; supports `bun-version-file` (reads .tool-versions); caches the binary by default.
- Action SHAs from release.yml: checkout v7.0.1 `3d3c42e5aac5ba805825da76410c181273ba90b1`, setup-node v7.1.0 `949feb2413d6458794dcd2491c4babbbce0c15c1`, pnpm/action-setup v6.1.0 `ea17c68df8912ef543352723c149a84f56e3d413`.
- npm/cmd-shim `.cmd` template (used by npm, pnpm and Corepack bins), below.
- Corepack: `corepack enable yarn` installs only yarn's shims; `COREPACK_ENABLE_AUTO_PIN` is opt-in; `COREPACK_ENABLE_DOWNLOAD_PROMPT` defaults to 1 for implicit calls.
- With `CI=true`: `pnpm install` is frozen-lockfile and berry's `enableImmutableInstalls` is on, so the harness passes `--no-frozen-lockfile` / `--no-immutable` to every install it runs. bun and yarn v1 don't freeze.

## Module layout

```
.gitattributes                         # new (phase 1): * text=auto eol=lf
jest.config.ts                         # + testPathIgnorePatterns for __tests__/integration/ (phase 2)
jest.integration.config.ts             # new (phase 2)
package.json                           # + "test:integration" (phase 2)
__tests__/fixtures/index.ts            # + prependPath(), writeNodeShim() (phase 1)
__tests__/integration/
  harness.ts        # selection, env, copyRepo, pinToMinimum, prepareRepo, runCli, cleanup
  lockfiles.ts      # rewriteYarnV1Lock, rewriteBerryLock, rewriteBunLock (pure string functions)
  expectations.ts   # expected check records, plan rows, per-manager after-update manifests
  matrix.ts         # runMatrix(manager): describe/it bodies shared by every manager
  npm.test.ts pnpm.test.ts yarn.test.ts berry.test.ts bun.test.ts   # one line each: runMatrix('<pm>')
testRepos/<manager>-<layout>/…        # 12 repos + testRepos/README.md
```
One test file per manager: locally the managers spread across Jest workers; each CI job runs one. Inside a file repos run sequentially (avoids parallel yarn v1 cache use).

## Phase 1: Windows unit CI (#54, part 1)

1. `.gitattributes` (new): `* text=auto eol=lf`. Without it, Git for Windows (autocrlf) checks files out CRLF: Biome (`lineEnding: lf`) fails, fixtures gain `\r`, and `awk` reads `.tool-versions` with a trailing `\r`. Check: `git add --renormalize . && git status --short` shows only `.gitattributes`; `git ls-files --eol | grep 'i/crlf'` prints nothing (mark any intentional CRLF file `-text`).
2. `src/utils/files.ts`: the template paths at lines 107, 191, 238, 288 and `readSpec`'s `` `${dir}/package.json` `` (~line 358) become `path.join(...)`. Then ``rg '`\$\{[^}]+\}/' src`` finds none. In `__tests__/utils/files.test.ts`, any expectation comparing a literal `'/x/package.json'` path is built with `path.join`.
3. `__tests__/fixtures/index.ts`:
   - `prependPath(dir): () => void`: puts `dir` first on PATH, returns the restore; updates the existing key case-insensitively (Windows spells it `Path`): `Object.keys(process.env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'`, joined with `path.delimiter`.
   - `writeNodeShim(bin, name, scriptFile): void` writes a launcher the way managers install CLIs. POSIX: `bin/<name>` = `#!/bin/sh` + `exec node '<bin>/<scriptFile>' "$@"`, chmod 755. Windows: `bin/<name>.cmd`, the cmd-shim template joined with `\r\n` (its last line re-reads `%*`, the case in question):

     ```
     @ECHO off
     GOTO start
     :find_dp0
     SET dp0=%~dp0
     EXIT /b
     :start
     SETLOCAL
     CALL :find_dp0

     IF EXIST "%dp0%\node.exe" (
       SET "_prog=%dp0%\node.exe"
     ) ELSE (
       SET "_prog=node"
     )

     endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\<scriptFile>" %*
     ```

4. `__tests__/managers/realSubprocess.test.ts`: drop `posixIt` so both tests run everywhere. The fake npm becomes a Node script `bin/fake-npm.js` (paths embedded via `JSON.stringify`) that appends `JSON.stringify(process.argv.slice(2))` as one line to `argv.log`; for `outdated` it writes the report and sets `process.exitCode = 1` (no `process.exit`, so 1.5 MB flushes). Launched via `writeNodeShim(bin, 'npm', 'fake-npm.js')` + `prependPath(bin)`. `loggedCalls()` parses the JSON lines. The injection test uses `'left-pad;touch pwned'` (sh) and `'right-pad&echo pwned>pwned'` (cmd), expects `[['outdated','--json'], ['update', <both names in report order>]]`, and no `pwned` file. Doc comment: on Windows this goes through cmd.exe and a cmd-shim `%*`.
5. `__tests__/utils/runProcess.test.ts`: rename the POSIX-only "no shell" test to "passes arguments verbatim and runs nothing they contain" and run it everywhere; its args gain `'a&echo pwned>pwned'` and `'b@>=1.0.0 <2.0.0'`. Add `windowsIt` (`process.platform === 'win32' ? it : it.skip`): "a .cmd shim receives cmd.exe operators intact": write `print-args.js` (`console.log(JSON.stringify(process.argv.slice(2)))`), `writeNodeShim(bin, 'print-args', 'print-args.js')`, `prependPath(bin)`, `runProcess('print-args', args, { cwd })` with `['upgrade','dayjs@^1.11.23','react@>=19.0.0','left-pad@>=1.0.0 <2.0.0','ms@1 || 2','c@(1)','a&echo pwned>pwned','ms@2.1.3','*']`; expect parsed argv equal to args and no `pwned` in cwd. Keep the `buildWindowsCommand` string test.
6. `__tests__/repoConfig.test.ts`: `isIgnoredForCoverage` puts raw `repoRoot` (backslashes on Windows) into a RegExp and matches `/` patterns against `path.join` output: normalize both sides (`toPosix = (p) => p.split(path.sep).join('/')`; RegExp from `pattern.replace('<rootDir>', escapeRegExp(toPosix(repoRoot)))`, tested against `toPosix(path.join(repoRoot, file))`). Add "runs the unit suite on Linux and Windows" (ci.yml matches `/os: \[ubuntu-latest, windows-latest\]/`) and "pins every action to a release commit" (every `uses:` line in every `.github/workflows/*` matches `/uses: [\w.-]+\/[\w.-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/`).
7. `.github/workflows/ci.yml` rewritten:
```yaml
name: CI

on:
  push:
    branches: [ main ]
  pull_request:

# Actions are pinned to the commit of a release (version in the comment), as in release.yml;
# Dependabot proposes updates. Tool versions come from .tool-versions, as they do locally.
permissions:
  contents: read

concurrency:
  group: ${{ github.workflow }}-${{ github.ref }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}

jobs:
  test:
    strategy:
      fail-fast: false
      matrix:
        os: [ ubuntu-latest, windows-latest ]
    runs-on: ${{ matrix.os }}
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          persist-credentials: false
      - id: tools
        shell: bash
        run: echo "pnpm=$(awk '$1 == "pnpm" { print $2 }' .tool-versions)" >> "$GITHUB_OUTPUT"
      - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
        with:
          version: ${{ steps.tools.outputs.pnpm }}
      - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
        with:
          node-version-file: .tool-versions
          cache: pnpm
      - run: pnpm install --frozen-lockfile
      # Formatting and types don't depend on the OS: once is enough.
      - name: Check formatting and lint
        if: runner.os == 'Linux'
        run: pnpm run format-and-lint
      - name: Check TypeScript
        if: runner.os == 'Linux'
        run: pnpm run check-types
      - name: Run tests
        run: pnpm test
      - name: Build project
        run: pnpm run build
```
Keep `run: pnpm run format-and-lint` on its own line (repoConfig.test matches it). Check whether setup-node's `node-version-file` accepts `.tool-versions` (it does for asdf format); release.yml already uses it.
8. `.github/workflows/security.yml`: pin the same way (tools step, pinned actions, `version: ${{ steps.tools.outputs.pnpm }}` instead of `latest`).

Docs: `src/utils/CLAUDE.md` runProcess line: the Windows path is covered by the windows-latest job (`.cmd` shim test in runProcess.test.ts; realSubprocess.test.ts through `npm.cmd`). `CLAUDE.md` Testing Notes: CI runs the unit suite on ubuntu and windows; `.gitattributes` keeps LF; subprocess tests use `writeNodeShim`/`prependPath`; fix the stale "Jest with ts-jest" (the transform is `@swc/jest`). `docs-overview.md`: realSubprocess line → "fake npm via a sh wrapper / cmd-shim, all platforms".

Windows iteration (orchestrator pushes; fix each failure at its cause): likely suspects are literal POSIX paths in tests; `fs.symlinkSync` without a type in installed/peers/workspaces tests; tests isolating `~/.npmrc` via `HOME` (Windows uses `USERPROFILE`; tests that spy `os.homedir` are fine). A real product bug gets a regression test and a fix here if small, else decision 3. Contingency if the `.cmd` shim test shows mangled arguments: replace `buildWindowsCommand`'s quoting with cross-spawn's algorithm written inline (escape cmd metacharacters `()[]%!^"\`<>&|;, *?`with`^` around a quoted argument, twice when the target is a cmd-shim).

Verification. Local: the gates, `FORCE_COLOR=1 pnpm test`, the renormalize and eol checks. CI: jobs `test (ubuntu-latest)` and `test (windows-latest)`; Windows skips lint/types; Linux Jest reports exactly 1 skipped test (the `.cmd` shim test), Windows 0; Windows build green.

## Phase 2: Refreshed testRepos, harness, test:integration, Linux matrix (#44)

testRepos: delete `bun`, `bunCatalogsMonorepo`, `bunMonorepo`, `npm`, `npmMonorepo`, `pnpm`, `pnpmCatalogsMonorepo`, `pnpmMonorepo`, `yarn`, `yarnMonorepo` (including `.always-up-to-date.json` files and `bun/.gitignore`); `rg testRepos` and update references (pnpm-workspace.yaml `!testRepos/**` stays; .github/dependabot.yml `exclude-paths` stays; docs/roadmap.md stays until M2 closes).

Single layout, `testRepos/{npm,pnpm,yarn,berry,bun}-single/package.json` (name `autd-<pm>-single`):
```json
{
  "name": "autd-npm-single",
  "version": "1.0.0",
  "private": true,
  "description": "autd integration matrix: npm, single package",
  "dependencies": {
    "chalk": "^4.0.0",
    "commander": "^11.0.0",
    "dayjs": "1.11.9",
    "debug": "~4.3.1"
  },
  "devDependencies": { "ms": "~2.1.1", "uuid": "~9.0.0" }
}
```
yarn-single adds `"packageManager": "yarn@1.22.22"`; berry-single adds `"packageManager": "yarn@4.12.0"` (no `.yarnrc.yml`: PnP is default and packageManager alone makes isYarnBerry true).

Workspace layout `testRepos/{npm,yarn,berry,bun}-workspace` root:
```json
{
  "name": "autd-npm-workspace",
  "version": "1.0.0",
  "private": true,
  "description": "autd integration matrix: npm, workspace",
  "workspaces": ["packages/*"],
  "dependencies": { "dayjs": "1.11.9", "ms": "~2.1.1" }
}
```
yarn/berry add their packageManager. `pnpm-workspace`: same root without `workspaces` plus `pnpm-workspace.yaml` with `packages:\n  - packages/*`.
Every workspace and catalog repo has members:
- `packages/a/package.json`: `{ "name": "@autd/a", "version": "1.0.0", "private": true, "dependencies": { "chalk": "^4.0.0", "ms": "2.1.2" } }`
- `packages/b/package.json`: `{ "name": "@autd/b", "version": "1.0.0", "private": true, "dependencies": { "commander": "^11.0.0", "debug": "~4.3.1" }, "devDependencies": { "uuid": "~9.0.0" } }`

`testRepos/pnpm-catalogs`: pnpm-workspace.yaml
```yaml
packages:
  - packages/*

catalog:
  chalk: ^4.0.0
  ms: ~2.1.1

catalogs:
  tools:
    commander: ^11.0.0
    debug: ~4.3.1
```
root `{ "name": "autd-pnpm-catalogs", "version": "1.0.0", "private": true, "description": "…", "dependencies": { "dayjs": "1.11.9", "ms": "catalog:" } }`; `packages/a` deps `{ "chalk": "catalog:", "ms": "2.1.2" }`; `packages/b` deps `{ "commander": "catalog:tools", "debug": "catalog:tools" }`, devDeps `{ "uuid": "~9.0.0" }`.
`testRepos/bun-catalogs`: root package.json with `"workspaces": ["packages/*"]`, `"catalog": { "chalk": "^4.0.0", "ms": "~2.1.1" }`, `"catalogs": { "tools": { "commander": "^11.0.0", "debug": "~4.3.1" } }`, `"dependencies": { "dayjs": "1.11.9", "ms": "catalog:" }`; members as pnpm-catalogs.

Why this shape: each package in at most two manifests, never at the same installed version (avoids pnpm's #95 merge); dayjs only at the root (no npm dedupe onto the root pin); root `ms ~2.1.1` beside member pin `ms 2.1.2` exercises the together rule (an exact pin blocks nothing). Frozen maxima: chalk 4.1.2, commander 11.1.0, debug 4.3.7, uuid 9.0.1, ms 2.1.3. All deps incl. transitive are free of install scripts; the ranges exclude the Sept-2025 malicious chalk/debug/ansi-styles releases.

`testRepos/README.md`: purpose; frozen-line rule (only `^`/`~`/exact, no install scripts, no advisories, never semver <7.5.2 or lodash <4.17.21); lockfiles generated, never committed; how to run and which tools on PATH (npm, pnpm, yarn via Corepack, bun 1.4.0).
`.gitignore`: replace the Dependabot comment with the real reason (the suite generates lockfiles in temp copies); keep the four lockfile patterns; add `testRepos/**/.yarn/` and `testRepos/**/.pnp.*`.

Jest: `jest.config.ts` adds `testPathIgnorePatterns: ['/node_modules/', '<rootDir>/__tests__/integration/']`. `jest.integration.config.ts`:
```ts
import base from './jest.config.ts'
// The integration matrix: real package managers, network, minutes. Never part of `pnpm test` or coverage.
export default {
  ...base,
  roots: ['<rootDir>/__tests__/integration'],
  testMatch: ['**/*.test.ts'],
  testPathIgnorePatterns: ['/node_modules/'],
  collectCoverage: false,
  testTimeout: 10 * 60 * 1000,
}
```
`package.json`: `"test:integration": "pnpm run build && jest --config jest.integration.config.ts"`.

Harness `__tests__/integration/harness.ts`:
- `MANAGERS = ['npm','pnpm','yarn','berry','bun'] as const`; `selectedManagers(value = process.env.AUTD_INTEGRATION_PM)` (comma-separated, unset = all) throws on an unknown name listing the valid ones.
- `managerEnv()` in `beforeAll`, applied to `process.env` (runProcess passes `process.env` explicitly): delete every `/^npm_/i` key, `PNPM_SCRIPT_SRC_DIR`, `INIT_CWD` (pnpm run exports npm_config_* that npm/yarn read); set `COREPACK_ENABLE_DOWNLOAD_PROMPT=0`, `COREPACK_ENABLE_AUTO_PIN=0`, `YARN_ENABLE_TELEMETRY=0`, `YARN_ENABLE_SCRIPTS=false`.
- `copyRepo(dir)`: `fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), \`autd-it-${dir}-\`)))`(Windows runners return 8.3`RUNNER~1`while pnpm reports long paths; macOS`/var`→`/private/var`), then `fs.cpSync(src, tmp, { recursive: true, filter })`skipping node_modules, the four lockfiles,`.yarn`, `.pnp.*`. Outside the repo, so the root pnpm-workspace.yaml, Biome and git never see it and berry/pnpm find no parent project.
- `pinToMinimum(cwd)` → `{ restore, ranged: RangedDependency[] }`: visits every package.json under cwd outside node_modules (dependency fields, plus `catalog`/`catalogs.*` for bun) and `catalog:`/`catalogs:` entries of pnpm-workspace.yaml (line regex inside those blocks). A spec matching `/^[~^]\d+\.\d+\.\d+$/` becomes `semver.minVersion(spec).version`; exact versions, `catalog:` and `workspace:` stay; anything else throws ("testRepos use only exact, ^ and ~ specs"). `RangedDependency = { workspace?: string /* POSIX, '.' root */, catalog?: string /* 'default' | name */, name, range, installed }`. `restore()` writes back the original bytes of every touched file.
- `prepareRepo(repo)`: copy → pin → install → restore → make the lockfile agree; asserts the yarn version in the copy (`yarn --version` = 1.22.22 or 4.12.0) to catch a Corepack misconfiguration.

| Manager | Install at minimum                                                                      | Make the lockfile agree after restore                                                                                                                                                                                                                                  |
| ------- | --------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm     | `npm install --no-audit --no-fund --ignore-scripts`                                     | nothing (npm reads ranges from package.json)                                                                                                                                                                                                                           |
| pnpm    | `pnpm install --no-frozen-lockfile --ignore-scripts`                                    | nothing; for catalogs, confirm on the first run that `pnpm outdated` ignores the lockfile's `catalogs.*.specifier`, else rewrite it too                                                                                                                                |
| yarn v1 | `yarn install --non-interactive --ignore-scripts`                                       | `rewriteYarnV1Lock`: the key line listing `name@<installed>` gains `, name@<range>`                                                                                                                                                                                    |
| berry   | write an empty `yarn.lock` (marks the project root), then `yarn install --no-immutable` | `rewriteBerryLock`: `"name@npm:<installed>":` → `"name@npm:<installed>, name@npm:<range>":`, and inside each `"<wsName>@workspace:<path>":` entry `name: "npm:<installed>"` → `"npm:<range>"`; then `yarn install --no-immutable` (keeps versions, prunes unused keys) |
| bun     | `bun install --ignore-scripts`                                                          | `rewriteBunLock`: inside `"workspaces"` → `"<path>"` (root `""`), `"name": "<installed>"` → `"<range>"`; catalog entries inside top-level `"catalog"` and `"catalogs"` → `"<name>"` objects (extent by brace counting from the key)                                    |

`lockfiles.ts`: pure `(lock: string, ranged, …) => string`; keep line endings (split `/\r?\n/`, rejoin with the detected EOL); every expected rewrite that finds no match throws naming the lockfile and key. No separate unit tests: the integration run exercises them and the `check` assertions (`current` = installed minimum) verify the simulation.

`runCli(cwd, args)`: `runProcess(process.execPath, [CLI, ...args], { cwd })` with `CLI = path.join(__dirname, '..', '..', 'dist', 'index.js')`; returns `JSON.parse(stdout)`; on rejection throws an Error naming the command, cwd, the stdout JSON error object and `stripVTControlCharacters(stderr)`. `beforeAll` fails with "run pnpm run build" if dist/index.js is missing. Cleanup `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })`; `AUTD_INTEGRATION_KEEP=1` keeps it and prints the path via `process.stderr.write`.

`expectations.ts` (autd's output only, never manager output). `heldBeyondRange = expect.stringMatching(/^(patch|minor|major) beyond the range$/)`.
- `SINGLE_CHECK` projected to `{ current, wanted }`: chalk 4.0.0/4.1.2; commander 11.0.0/11.1.0; dayjs 1.11.9/1.11.9; debug 4.3.1/4.3.7; ms 2.1.1/2.1.3; uuid 9.0.0/9.0.1.
- `WORKSPACE_CHECK` (workspace and catalog layouts) projected to `{ current, wanted, workspaces }` (order is contract: root first, then by path): chalk `[{packages/a,4.0.0,4.1.2}]`; commander `[{packages/b,11.0.0,11.1.0}]`; dayjs `[{.,1.11.9,1.11.9}]`; debug `[{packages/b,4.3.1,4.3.7}]`; ms top-level 2.1.1/2.1.3, `[{.,2.1.1,2.1.3},{packages/a,2.1.2,2.1.2}]`; uuid `[{packages/b,9.0.0,9.0.1}]`.
- Plan rows projected to `{ name, workspace, current, wanted, target, updated, reason }`, sorted by name then workspace. Single: chalk→4.1.2, commander→11.1.0, dayjs held, debug→4.3.7, ms→2.1.3, uuid→9.0.1. Workspace/catalogs: chalk/packages/a→4.1.2, commander/packages/b→11.1.0, dayjs/. held, debug/packages/b→4.3.7, ms/.→2.1.3, ms/packages/a held, uuid/packages/b→9.0.1.
- `update --json` = plan rows plus per-manager overrides for rows the manager leaves in place (e.g. if pnpm keeps root ms at 2.1.1, the pnpm-workspace and pnpm-catalogs rows record `{ updated: false, reason: 'not applied by pnpm (installed 2.1.1)' }` with a comment naming the cause).
- Manifests after update (compare parsed dependency maps and catalogs, not bytes): npm, yarn v1, berry unchanged in every layout; pnpm and bun raise floors (expected chalk ^4.1.2, commander ^11.1.0, debug ~4.3.7, ms ~2.1.3, uuid ~9.0.1; pins and unnamed entries stay); whether pnpm's/bun's catalog entries move is captured on the first run.
- The first real run is compared to these; each difference is classified before any expectation changes: (a) harness bug → fix the harness; (b) known manager behavior → per-manager override with comment + issue number; (c) autd bug → decision 3. Never paste output into expectations unclassified.

`matrix.ts`: `runMatrix(manager)` uses `describe` when selected, `describe.skip` otherwise; one `describe` per repo (beforeAll sets up cwd, afterAll cleans), `it`s in order: (1) `check --json` equals `*_CHECK` with exact key sets; (2) `update --dry-run --json` equals the plan rows; (3) `update --json` equals the update rows; (4) manifests/catalogs equal the after-update table; (5) `check --json` again: every moved (name, workspace) is absent or has `current === target`, and the pins are present with unchanged current (dayjs 1.11.9, packages/a ms 2.1.2). Works for every manager incl. PnP.

Repo guards (`repoConfig.test.ts`): "keeps the integration matrix out of pnpm test" (`jestConfig.testPathIgnorePatterns` contains `'<rootDir>/__tests__/integration/'`); "runs the integration matrix per manager in CI" (ci.yml contains `pm: [npm, pnpm, yarn, berry, bun]` and `run: pnpm run test:integration`).

CI (`ci.yml`, new job after `test`):
```yaml
integration:
  # Real package managers against temp copies of testRepos/. One job per manager, so each
  # installs only its own. Only the repo's pnpm store is cached (setup-node); the managers'
  # caches for testRepos never are: each run resolves from the registry like a fresh machine.
  strategy:
    fail-fast: false
    matrix:
      os: [ ubuntu-latest ]
      pm: [ npm, pnpm, yarn, berry, bun ]
  runs-on: ${{ matrix.os }}
  timeout-minutes: 20
  env:
    AUTD_INTEGRATION_PM: ${{ matrix.pm }}
  steps:
    - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      with:
        persist-credentials: false
    - id: tools
      shell: bash
      run: echo "pnpm=$(awk '$1 == "pnpm" { print $2 }' .tool-versions)" >> "$GITHUB_OUTPUT"
    - uses: pnpm/action-setup@ea17c68df8912ef543352723c149a84f56e3d413 # v6.1.0
      with:
        version: ${{ steps.tools.outputs.pnpm }}
    - uses: actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0
      with:
        node-version-file: .tool-versions
        cache: pnpm
    # yarn 1.22.22 / 4.12.0 come from each testRepo's packageManager, through Corepack.
    # Only yarn's shims, so pnpm stays the version set up above.
    - name: Enable yarn through Corepack
      if: matrix.pm == 'yarn' || matrix.pm == 'berry'
      run: corepack enable yarn
    - name: Set up Bun
      if: matrix.pm == 'bun'
      uses: oven-sh/setup-bun@0c5077e51419868618aeaa5fe8019c62421857d6 # v2.2.0
      with:
        bun-version-file: .tool-versions
    - name: Show tool versions
      shell: bash
      run: |
        node --version; npm --version; pnpm --version
        if [ "$AUTD_INTEGRATION_PM" = bun ]; then bun --version; fi
    - run: pnpm install --frozen-lockfile
    - name: Run the integration matrix
      run: pnpm run test:integration
    - name: The suite leaves the checkout untouched
      shell: bash
      run: test -z "$(git status --porcelain)" || { git status --porcelain; exit 1; }
```

Docs: `CLAUDE.md` (Testing: `pnpm run test:integration`, `AUTD_INTEGRATION_PM`, network required, outside `pnpm test` and coverage, `AUTD_INTEGRATION_KEEP`; Architecture: what testRepos/ is now); `docs-overview.md` (`__tests__/integration/*`, `jest.integration.config.ts`, `testRepos/`); `src/managers/CLAUDE.md` ("Integration matrix" paragraph listing observed manager behaviors it asserts); `docs/contributing.md` short "Integration tests" section if the file exists.

Verification local (macOS): gates; `pnpm test -- --listTests | grep integration` prints nothing; `pnpm run test:integration` (all five; yarn needs Corepack shims first on PATH: `/private/tmp/claude-501/-Users-tylerrobertson-personal-dev-always-up-to-date/6a97c94d-c45b-4048-ab0a-4467299b24bf/scratchpad/corepack-bin`); `CI=true pnpm run test:integration`; `AUTD_INTEGRATION_PM=berry …`; `AUTD_INTEGRATION_PM=nope …` fails fast; `AUTD_INTEGRATION_KEEP=1 AUTD_INTEGRATION_PM=npm …` then `npm audit` in the kept dirs (0 vulnerabilities); `pnpm run test:coverage` numbers unchanged; `git status --porcelain` clean. CI: five `integration (<pm>, ubuntu-latest)` jobs, each 4 skipped suites + 1 passed; only yarn/berry run the Corepack step, only bun sets up Bun; untouched-checkout step green.

## Phase 3: Integration matrix on Windows (#54, part 2)

- `ci.yml` integration job: `os: [ubuntu-latest, windows-latest]`, `timeout-minutes: 30`.
- Watch for: short-name temp paths (handled by realpathSync.native); `EBUSY` on cleanup (retries); bun's table format on Windows; CRLF lockfiles (rewriters keep EOL); Corepack's `yarn.cmd`; pnpm's `location` paths; `--filter *` through cmd (passes literally). Fix in the harness, or in src with a unit regression test.
- Docs: CLAUDE.md and `src/utils/CLAUDE.md` say the integration matrix also runs on Windows.
- CI: ten integration jobs green.

## Risks

- Registry flakiness: no automatic retries; rerun the job.
- Corepack fetches yarn on first use (prompt disabled).
- The `.cmd` quoting turns out wrong: cross-spawn-style escaping (Phase 1 contingency).
- Job rename `test` → `test (ubuntu-latest)` / `test (windows-latest)`: no required checks on main, so nothing to update.
