# Per-manager `.npmrc` layering (#117, #118, #122)

Issues: #117, #118, #122. Milestone: M3. Planned 2026-10-26 against `main` at 5f7512e.

- [ ] Phase 1: Shared layer seam, no behavior change (PR A, first commit)
- [ ] Phase 2: pnpm 12 layers, closes #117 (PR A)
- [ ] Phase 3: bun's user `.npmrc`, closes #118 (PR B, off `main` after A merges)
- [ ] Phase 4: yarn v1 member and parent `.npmrc`, closes #122 (PR C, off `main` after A merges, independent of B)

**Decided 2026-10-26** (the orchestrator, under the user's "go with what's right"):
1. **Record-only findings:** each one a probe confirms (yarn v1's `always-auth` and bare `_authToken`, pnpm 12 ignoring non-auth `.npmrc` keys, the per-member `yarn workspace <m> upgrade` reading the member's `.npmrc`, pnpm 12.15's `include:` in `pnpm-workspace.yaml`, `bun.saveStyle` reading `save-exact` through npm's layers) is filed as its own M3 issue with `/ship:issue`. These PRs stay within each issue's Evidence and Fix direction.
2. **pnpm's global config directory on Linux and Windows** comes from pnpm's source at tag `v12.15.0`. It is unit-tested on an injected `platform` and listed under the PR's Not verified. No one-off CI job.

## Probe results, 2026-10-26 (they supersede the design below where they differ)

Every planned row ran: p20–p60 on pnpm 12.15.0 and 12.14.0, which agree on all 111 rows; b20–b33 on bun 1.4.4, the latest; y20–y36 on yarn 1.22.22. The full write-up, with a table per manager and a decision per row, is `<scratchpad>/registry-probe/layering-results.md`. Raw rows are in `results.jsonl`, and each case's project, home, output and requests are in `cases/<tool>/<id>/`. Paired autd twins are prepared (`paired.cjs`, `AUTD_TWINS=1`) and run after `pnpm run build` in each phase's real-run step.

**The seam changes the probes force**
- `EnvRule.key(rest)` can't see which prefix matched, and pnpm pairs `pnpm_config_<lower_snake>` with `PNPM_CONFIG_<UPPER_SNAKE>` (p20). So `key` takes the full variable name: `key(rest, name)`.
- `substitute: null` on a project file means an entry still holding `${…}`, in its key or value, is **left out**, and a lower layer decides (p30–p32).
- Expansion flavors differ per manager, so each file layer takes its own `Substitute`:
  - **pnpm user and global files:** `${VAR}` and `${VAR:-default}` expand in keys and values. An unset `${VAR}` becomes `''` and shadows lower layers; for a token, pnpm sends `Authorization: Bearer` with nothing after it (p34, p35b, p36).
  - **pnpm env values:** expanded, `${VAR:-default}` included (p26).
  - **bun:** `${VAR}` anywhere; `$VAR` only as the whole value. An unset variable stays literal and is sent (b30, b31).
  - **yarn:** file values expand, env values don't. An unset variable makes yarn fail (y31, y32).
  - **autd's own rule stays:** a credential still holding `${…}` is absent. For bun's literal and pnpm's empty token this sends no `Authorization` header where the manager sends a broken one. Both fail auth the same way; document it.

**pnpm 12, corrected layer order** (highest first, per key)
1. `pnpm_config_*` / `PNPM_CONFIG_*`. Case pairing per p20. `_` maps to `-`; camelCase isn't read (p25). `//` keys are kept as written (p22). `@scope:registry` is **not** read from env (p21).
2. `npm_config_*` / `NPM_CONFIG_*`, **credential keys only** (`//host/:_authToken`, `_auth` and the other `//` keys), values not expanded (p23). Every other `npm_config_*` key, routes included, is ignored. This contradicts #117's "npm_config_* not read"; the PR says so.
3. Project `pnpm-workspace.yaml`, routes. A `${…}` value falls through (p33).
4. Global `config.yaml`, routes only, no credentials (p43).
5. Project `.npmrc`, with `${…}` entries left out (p30–p32).
6. Global `auth.ini`, expanded (p36).
7. The user file: `pnpm_config_userconfig`, else `npm_config_userconfig`, else `~/.npmrc`. A relative path is cwd-relative, `~` isn't expanded, and a missing file means no user layer (p24).

The config directory is `$XDG_CONFIG_HOME/pnpm`, where a relative XDG resolves against cwd, not HOME, with no fallback (p53). macOS without XDG uses `~/Library/Preferences/pnpm`, and `~/.config/pnpm` isn't read there (p50–p52). The legacy `rc` and npm's `<prefix>/etc/npmrc` are not read (p54, p55).

**bun 1.4.4, corrected**
- Layers: project `.npmrc`, then one user file, chosen in this order:
  1. `NPM_CONFIG_USERCONFIG`, then `npm_config_userconfig`; upper case wins (b22). Its path is cwd-relative, with `~/` expanded. It replaces both files below.
  2. `$XDG_CONFIG_HOME/.npmrc` if any entry exists there, an empty file or a directory included (b20, b20b; not `isFile()`). Only an absolute XDG is used (b21).
  3. `~/.npmrc`.
- No env layer (b26, b27). No prefix or parent `.npmrc` (b32, b33).
- `NPM_CONFIG_TOKEN` and `BUN_CONFIG_TOKEN` beat `.npmrc` tokens on `.npmrc` routes too (b28, b29). Check that `bunfig.ts` already does this.
- The plan's 3b line "no longer reads `npm_config_userconfig`" is wrong: bun does read it.

**yarn 1.22.22:** the plan's yarn row holds.
- Credentials layer like routes: member, then home, then root (y20–y22).
- A parent `.npmrc` beats `.yarnrc` (y23).
- Home comes before the prefix file, which comes before parents, and parents supply credentials (y24–y27).
- `userconfig` replaces `~/.npmrc`, cwd-relative with no `~` expansion (y28).
- Env credentials are mangled, so none are read; env scopes are lower-cased (y29, y30).
- **Limitation:** Homebrew's yarn wrapper forces `PREFIX=/opt/homebrew`, so autd's `PREFIX ?? execPrefix` reads a different prefix file than Homebrew yarn unless `PREFIX` is set. Document it, don't chase it.

**Record-only findings, filed 2026-10-26 as #125 (pnpm `fetchTimeout`/`fetchRetries`, p60), #126 (yarn v1 `always-auth` and bare `_authToken`, y33–y35) and #127 (yarn v1 per-member upgrade, y36). Not fixed here:**
- p60: pnpm 12 reads `fetch-timeout` / `fetch-retries` only from `pnpm-workspace.yaml` (`fetchTimeout`, `fetchRetries`), not from `.npmrc`. It still honors `.npmrc` `strict-ssl`, `cafile`, `ca`, `proxy`, `https-proxy` and `noproxy`, and applies `HTTPS_PROXY` to `http://` registries.
- y33/y34: yarn v1 sends no auth for unscoped packages without `always-auth`.
- y35: yarn v1 sends a bare `_authToken` for scoped packages.
- y36: `yarn workspace <m> upgrade` resolves with the member's `.npmrc` route.

Rules for every phase:
- Each phase leaves `pnpm run check-types`, `pnpm run format-and-lint`, `pnpm test`, `pnpm run build` and `pnpm run test:integration` green. Run the matrix on all five managers, with Corepack's yarn first on PATH.
- Don't commit; the orchestrator commits per phase.
- Re-read each issue with `gh issue view <n> --comments` before writing its Evidence tests. The planner read them from github.com.

## Overview

**Goal.** autd's registry view (routes, credentials, and the other `RegistryConfig` fields) is built from each manager's own `.npmrc` layers: which files, in what order, which environment prefix, and where `${VAR}` expands. Today every manager gets npm 12's layering.

**Acceptance criteria**
- **Every Evidence row of #117, #118 and #122,** and #122's comment example, stops reproducing:
  1. a unit test on temp dirs asserts that autd's `RegistryConfig` routes and credentials equal what the manager did;
  2. a paired real run, the manager and then the built autd through the probe harness, shows autd's requests reaching the same server with the same `Authorization` header.
- **Every Fix direction is carried out:**
  - **#117:** add the `pnpm_config_*`, global `config.yaml` and global `auth.ini` layers in pnpm's order; drop `npm_config_*` for pnpm; don't expand `${VAR}` in the project `.npmrc` or `pnpm-workspace.yaml`.
  - **#118:** bun's user layer is one file, `$XDG_CONFIG_HOME/.npmrc` when it exists, else `~/.npmrc`; no npm global npmrc.
  - **#122:** yarn v1 gets its own per-key layering: member, then `~/.npmrc`, then the root's, plus parents, the prefix file and env. Credentials are checked with a real run. npm keeps its rule.
- **npm stays byte-identical:**
  - `__tests__/utils/npmrcLoader.test.ts` and `__tests__/utils/npmrc.test.ts` pass with no edits;
  - the `__tests__/singlePackageJson.test.ts` snapshot is not updated;
  - the matrix's npm rows are unchanged.
- **Startup stays lean:**
  - `__tests__/startup.test.ts` passes unchanged;
  - the session reads no file until its first `registryConfig()`, which `__tests__/project.test.ts` asserts for both hooks.

**Out of scope:** #123 (detecting the manager from a member; the real runs use `--pm`), yarn berry's `.yarnrc.yml` (berry keeps npm's view), the cache (#108).

**Versions:** probe on each manager's current release.
- **pnpm:** 12.15.0 is latest (21 Oct). Also run 12.14.0, the repo pin, as #117 did.
- **bun:** confirm 1.4.4 is still the latest release first; if a newer one exists, probe that.
- **yarn:** 1.22.22, the last v1.

## Technical Architecture

### The seam: `src/utils/npmrcLoader.ts`

A manager declares an ordered list of layers, highest first. The loader merges them per key and records which layer set each key. npm's current logic becomes one such list.

```ts
export type Substitute = (text: string, env: NodeJS.ProcessEnv) => string

/** One source of .npmrc settings; a missing or unreadable file is an empty layer. */
export type NpmrcLayer =
  | { kind: 'env'; values: Npmrc }
  | { kind: 'file'; file: string; values: Npmrc }

/** The merged settings, and the layer that set each key. */
export interface NpmrcView {
  values: Npmrc
  origin(key: string): NpmrcLayer | undefined
}

/** How a manager reads its configuration variables. */
export interface EnvRule {
  /** Matches the variable names the manager reads; the rest of the name is the key. */
  prefix: RegExp
  /** The .npmrc key for the rest of a name; undefined skips the variable. */
  key(rest: string): string | undefined
  /** Applied to values; null leaves them as written. */
  substitute: Substitute | null
}

export const NPM_ENV: EnvRule // /^npm_config_/i; `//` keys as written, else (?!^)_ → '-', lower case; substituteEnv
export const envLayer: (env: NodeJS.ProcessEnv, rule: EnvRule) => NpmrcLayer
export const npmrcFileLayer: (
  file: string,
  env: NodeJS.ProcessEnv,
  options?: { substitute?: Substitute | null }, // default substituteEnv
) => NpmrcLayer
export const mergeNpmrcLayers: (layers: readonly NpmrcLayer[]) => NpmrcView // highest first
export const npmNpmrcLayers: (cwd: string, sources?: NpmrcSources) => NpmrcLayer[]
export const execPrefix: (sources: NpmrcSources) => string // win32: dirname(execPath); else dirname(dirname(execPath))
```

- **`mergeNpmrcLayers`** walks the layers from lowest to highest, assigning every own key onto an `Object.create(null)` object. A higher layer overwrites a lower one whatever the value's type, as `Object.assign` does today. It also records the winning layer per key in a `Map`.
- **`substitute: null` on a file layer** means `${VAR}` is not expanded (pnpm's project files). What happens to a value that still holds `${…}` is settled by probes p30–p32: either it is left out of the layer so a lower layer decides, or it is kept as written and shadows lower layers. Implement whichever pnpm does, and name the probe in the comment.
- **`parseNpmrc(text, env, substitute = substituteEnv)`** (`src/utils/npmrc.ts`) gets a third parameter, used for keys and values. The default keeps every existing call and `npmrc.test.ts` unchanged; null maps to an identity function.
- **`npmNpmrcLayers`** is today's `loadNpmrc` body returning `[env, project, user, global, builtin]` instead of merging.
  - The project-is-the-user-config skip yields an empty project layer.
  - `pick()`, `userconfigOf`, prefix and `globalconfig` resolution stay exactly as written.
  - `envConfig` becomes `envLayer(env, NPM_ENV)`, and `readNpmrc` becomes `npmrcFileLayer(...).values`.
- **`loadNpmrc(cwd, sources)`** becomes `mergeNpmrcLayers(npmNpmrcLayers(cwd, sources)).values`, and **`loadRegistryConfig(cwd, sources)`** stays as it is.
  - Drop the third `projectRoot` parameter from both: once pnpm owns its layers, it is dead.
  - Grep for `projectRoot` and update every caller; npmrcLoader's tests never pass it.
- `registryConfigFrom`, `credentialsFrom`, `caFrom`, `proxyFrom` and the numbers are untouched.

### Adapter hooks: `src/managers/adapter.ts`

- **Add** `npmrcLayers?(cwd: string, sources: NpmrcSources): NpmrcLayer[]`: the `.npmrc` layers this manager reads, highest first. Without it, npm's (`npmNpmrcLayers`). Called once, on the session's first use.
- **Change** `registryConfig?(cwd, fromNpmrc, sources)` to `registryConfig?(cwd, fromNpmrc, sources, npmrc: NpmrcView)`. bun's and yarn's hooks build on the view, and yarn uses `origin`. Existing implementations may ignore the fourth argument.
- **Remove** `projectRoot?(cwd)`. pnpm's layers find its root themselves. Update the doc comments; `registryConfig?` no longer mentions pnpm.

### Composition: `src/project.ts`

```ts
loadConfig: (dir) => {
  const sources = processSources()
  const npmrc = mergeNpmrcLayers((adapter.npmrcLayers ?? npmNpmrcLayers)(dir, sources))
  const fromNpmrc = registryConfigFrom(npmrc.values, dir, sources)
  return adapter.registryConfig?.(dir, fromNpmrc, sources, npmrc) ?? fromNpmrc
},
```

For npm this is exactly `loadRegistryConfig(dir, sources)`. It still runs only inside the session's lazy `loadConfig`, so `openProject` reads nothing.

### Target layers per manager (highest first; per key, the first layer that sets a key wins)

| Manager         | Layers                                                                                                                                                                                                                             | Env                                                                                                    | `${VAR}`                                                                                               |
| --------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------ |
| npm (unchanged) | `npm_config_*` → project `.npmrc` (npm project root) → user (`userconfig` / `~/.npmrc`) → `globalconfig` / `<prefix>/etc/npmrc` → builtin                                                                                          | `NPM_ENV`                                                                                              | expanded everywhere (npm's rules)                                                                      |
| pnpm 12         | `pnpm_config_*` → project `pnpm-workspace.yaml` (routes) → global `config.yaml` (routes, credentials if p43 shows them) → project `.npmrc` → global `auth.ini` → `~/.npmrc`. Project = nearest ancestor with `pnpm-workspace.yaml` | `PNPM_ENV` (naming per p20–p25)                                                                        | not in project `.npmrc` / yaml; expanded in `auth.ini`, `config.yaml`, `~/.npmrc` (flavor per p34–p35) |
| bun 1.4.x       | project `.npmrc` (`findNpmProjectRoot`: workspace root from a member) → one user file: `$XDG_CONFIG_HOME/.npmrc` if it exists, else `~/.npmrc`                                                                                     | none, unless b26–b27 show bun reads more than the registry/token variables `bunfig.ts` already handles | expanded (b5e, b7f, b7g); `$VAR` per b30                                                               |
| yarn v1         | yarn's `npm_config_*` → `<cwd>/.npmrc` → `npm_config_userconfig` or `~/.npmrc` → `${PREFIX or execPrefix}/etc/npmrc` → each parent's `.npmrc`, nearest first, not the filesystem root                                              | `YARN_NPM_ENV` (yarn's normalization)                                                                  | per y31                                                                                                |
| yarn berry      | npm's (unchanged; berry is out of scope)                                                                                                                                                                                           |                                                                                                        |                                                                                                        |

**Existing evidence these rows rest on** (`<scratchpad>/registry-probe/results.jsonl`):
- **pnpm:** p6d, p6e, p6k, p7a–c and p9a–e, plus the precedence in #117. A member reads only the root's files (ra1–ra8).
- **bun:** b6, b7, b7b–b7e, b7h and b7i, plus #118. A member reads only the root's `.npmrc` (rb3–rb6).
- **yarn:** #122, y11, x4, and its comment (from yarn source).

### Why pnpm's yaml routes become layers

The precedence in #117 puts env above the project yaml, and the global `config.yaml` between the project yaml and the project `.npmrc`. That can't be done by overlaying yaml routes on a finished `.npmrc` view, which is what `applyPnpmRegistrySettings` does today.

Turning each yaml file's routes into an `NpmrcLayer` (`{ registry, '@scope:registry' }`) and placing it in the list gives the per-key result in p7c, p6d and p6k with no special cases. pnpm then needs no `registryConfig` hook.

bun (`bunfig.ts`) and yarn (`yarnrc.ts`) keep their hooks: their precedence interleaves variables, flags and per-route credentials in ways per-key layers can't express.

### State, startup, dependencies

- **No new dependencies:** only Node's `fs` and `path`.
- **Manager behavior comes from real runs.** The one exception is pnpm's config directory off macOS, which comes from pnpm's source at tag `v12.15.0`. The path `config/config/src/dirs.ts` on `main` returns 404, so search the tag for `Library/Preferences` to find `getConfigDir`.
- **The new modules load at startup,** like `registries.ts`, `bunfig.ts` and `yarnrc.ts` do today, because `src/managers/index.ts` imports every adapter. Each may import only `fs`, `path`, types, `@/utils/npmrcLoader`, `@/utils/npmrc`, `@/utils/logger` and `@/utils/saveStyle`, never the registry client or reader.

### PR shape: three PRs, A first, then B and C independently

- **PR A** (`fix/117-pnpm-npmrc-layers`): Phase 1 then Phase 2, closes #117.
  - It carries the seam because pnpm uses every part of it: an env rule, unexpanded project files, extra file layers and layers built from yaml.
  - The seam is reviewed next to a real consumer, and it lands in one PR whose own npm tests prove it changes nothing.
- **PR B** (`fix/118-bun-user-npmrc`) and **PR C** (`fix/122-yarn-member-npmrc`) branch from `main` after A merges. They touch different manager directories and are independent of each other, so there is no stack.
- **Probes run up front.** Run Phase 3's and Phase 4's probes before finishing PR A, so the seam already covers bun's and yarn's outcomes and B and C don't change it.
- **Merge conflicts:** B and C each edit their own sub-bullet in the same doc sections. Whichever merges second resolves at most a one-line conflict when merging `main` in before handover.
- **Labels:** all three go on M3 and are labelled `bug`.

## Implementation Phases

### Probe harness changes (scratchpad, not the repo)

Harness: `/private/tmp/claude-501/-Users-tylerrobertson-personal-dev-always-up-to-date/0ad6583b-1ee2-419e-bf06-969005b862bb/scratchpad/registry-probe/`

1. **`run.cjs` `fill()`:** add `{HOME}` and `{PROJECT}` (the case's home and project directories), applied to file text and env values. `npm_config_userconfig`, `PREFIX` and relative `XDG_CONFIG_HOME` cases need them.
2. **`run.cjs` `TOOLS`:** add `autd: '/Users/tylerrobertson/.asdf/installs/nodejs/24.22.1/bin/node'`.
3. **A `paired(c, pm)` helper in each case file.** It returns the manager case plus an autd twin:
   - `tool: 'autd'`, `id: \`${c.id}-autd\``;
   - `args: ['/Users/tylerrobertson/personal_dev/always-up-to-date/dist/index.js', 'check', '--json', '--pm', pm]`;
   - an empty `node_modules/.keep`, in `c.cwd` when set, so native discovery runs. A missing package becomes `current: 'missing'` and is looked up, so the 404 reaches the log.
4. **How to compare:** `classify()` already reports server and `Authorization` for the scoped and unscoped requests. autd's line must match the manager's. autd's `not-found` failure and exit code 1 are expected.
5. **Rebuild before each autd run:** `pnpm run build`.
6. **New case files:** `cases-pnpm-layers.cjs` (both pnpm tools), `cases-bun-layers.cjs`, `cases-yarn-layers.cjs`.
7. **Record the outcomes:**
   - the date and version go in the code comment each outcome decides ("Verified on pnpm 12.15.0 and 12.14.0, <date>");
   - the comparison table goes in the PR's Real run.

### Phase 1 — Shared layer seam (PR A, commit 1; no behavior change)

**Tasks**
- `src/utils/npmrc.ts`: give `parseNpmrc` its `substitute` parameter, default `substituteEnv`, used for both the key and the value.
- `src/utils/npmrcLoader.ts`:
  - add the types and functions above, and extract `execPrefix`;
  - rewrite `loadNpmrc` over `npmNpmrcLayers` and `mergeNpmrcLayers`, and drop `projectRoot`;
  - keep `nonEmpty`, `isRegistryUrl`, `findNpmProjectRoot`, `processSources` and `registryConfigFrom` exported as they are.
- `src/managers/adapter.ts`: add `npmrcLayers?`, add the fourth `registryConfig?` parameter, remove `projectRoot?`.
- `src/project.ts`: the composition above.
- `src/managers/pnpm/index.ts`: until Phase 2 replaces it, keep today's behavior through the new composition. Simplest: a temporary `npmrcLayers` of `npmNpmrcLayers(pnpmProjectRoot(cwd), sources)`, which keeps reading the root's `.npmrc` from a member. Or fold Phases 1 and 2 into the same branch and never ship that intermediate state.
- Barrel: export nothing new (`src/utils/index.ts` already exports `loadRegistryConfig`).

**Tests**
- `__tests__/utils/npmrcLoader.test.ts` and `__tests__/utils/npmrc.test.ts`: no edits, all green. This is the npm byte-identity proof.
- New `__tests__/utils/npmrcLayers.test.ts`, on temp dirs with injected `NpmrcSources` (tmp `home`, `execPath` at `<tmp>/prefix/bin/node`, explicit `platform`):
  - `mergeNpmrcLayers`: highest first per key; a boolean, `null` or array value overrides a lower string; `origin` names the winning layer; an empty list gives `{}`.
  - `envLayer`: a custom `prefix` regex; a `key()` returning undefined skips the variable; empty values are skipped; `substitute: null` leaves `${X}` as written.
  - `npmrcFileLayer`: a missing or unreadable file is empty; `substitute: null` follows the rule p30–p32 choose.
  - `npmNpmrcLayers`: returns five layers in order, and its merge equals `loadNpmrc`.
- `__tests__/project.test.ts`:
  - `loadConfig` calls `adapter.npmrcLayers` when present and `npmNpmrcLayers` otherwise;
  - it passes the merged view as the fourth argument of `registryConfig`;
  - `openProject` calls neither hook.
  - The existing `jest.spyOn(pnpm, 'registryConfig')` test moves to `npmrcLayers` in Phase 2, since pnpm loses that hook there.
- `__tests__/startup.test.ts` unchanged.

**Errors:** a layer never throws. Unreadable files are empty layers, as today, and the session's fail-open behavior is untouched.

### Phase 2 — pnpm 12 (PR A, closes #117)

**2a. Probes first.** `cases-pnpm-layers.cjs`, each case on pnpm 12.15.0 and 12.14.0. Every case that settles a route or credential is `paired(c, 'pnpm')`.

| Id                  | Setup                                                                                                                       | Settles → decision                                                                                                                   |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| p20                 | `PNPM_CONFIG_REGISTRY={B}`, project `.npmrc` `registry={A}`                                                                 | Is the prefix case-insensitive? → `PNPM_ENV.prefix` flags                                                                            |
| p21                 | `pnpm_config_@acme:registry={B}`, project `.npmrc` `@acme:registry={A}`                                                     | Scope keys from env? → `key()` keeps `@scope:registry`                                                                               |
| p22                 | `pnpm_config_//{BH}/:_authToken=E`, project `.npmrc` `registry={B}`                                                         | Credentials from env? → `key()` keeps `//` keys as written, or skips them                                                            |
| p23                 | `npm_config_//{BH}/:_authToken=E`, project `.npmrc` `registry={B}`                                                          | Confirms `npm_config_*` is dropped for credentials too (expect no auth)                                                              |
| p24                 | `npm_config_userconfig={HOME}/alt.npmrc` (`registry={B}`)                                                                   | Confirms the user file is always `~/.npmrc` (expect npmjs)                                                                           |
| p25                 | `pnpm_config_fetch_timeout=1` and `pnpm_config_fetchTimeout=1`, `args: ['config','get','fetch-timeout']` and `fetchTimeout` | Which multi-word spelling pnpm honors → `key()` maps it to `fetch-timeout`                                                           |
| p26                 | `pnpm_config_registry=http://127.0.0.1:${PORT}/`, `PORT={BP}`                                                               | Env values expanded? → `PNPM_ENV.substitute`                                                                                         |
| p30                 | project `.npmrc` `registry=http://127.0.0.1:${PORT}/`, `~/.npmrc` `registry={A}`                                            | A means the value is left out (lower layer decides); npmjs means it shadows. Sets `substitute: null` semantics                       |
| p31                 | project `.npmrc` `registry={B}` + `//{BH}/:_authToken=${TOK}` (`TOK` set), `~/.npmrc` `//{BH}/:_authToken=U`                | `Bearer U` means left out; none means it shadows. Must agree with p30                                                                |
| p32                 | project `.npmrc` `registry={A}` + `@acme:registry=http://127.0.0.1:${PORT}/`, `~/.npmrc` `@acme:registry={B}`               | Same rule for scopes                                                                                                                 |
| p33                 | project yaml `registry: http://127.0.0.1:${PORT}/`, global `config.yaml` `registry: {B}`                                    | Confirms a project-yaml `${…}` falls through (expect B)                                                                              |
| p34                 | `~/.npmrc` `registry=http://127.0.0.1:${UNSET:-{BP}}/`                                                                      | pnpm's `${VAR:-default}`? → a `substitutePnpm` for user and global layers, else `substituteEnv`                                      |
| p35                 | `~/.npmrc` `registry=http://127.0.0.1:${UNSET}/`, `auth.ini` `registry={A}`                                                 | Unset in a global file: left out or literal → the same rule as above                                                                 |
| p36                 | `auth.ini` `//{BH}/:_authToken=${TOK}` (`TOK` set), project `.npmrc` `registry={B}`                                         | `auth.ini` expands credentials                                                                                                       |
| p40                 | `auth.ini` `//{BH}/:_authToken=G`, project `.npmrc` `registry={B}`                                                          | Credentials from `auth.ini` (expect `Bearer G`)                                                                                      |
| p41                 | `auth.ini` token G, project `.npmrc` token P (same host)                                                                    | Project `.npmrc` beats `auth.ini` per key (expect P)                                                                                 |
| p42                 | `auth.ini` token G, `~/.npmrc` token U                                                                                      | `auth.ini` beats `~/.npmrc` (expect G)                                                                                               |
| p43                 | `config.yaml` `"//{BH}/:_authToken": Y`, project `.npmrc` `registry={B}`                                                    | Does `config.yaml` carry credentials? If sent: read top-level quoted `//…` keys of `config.yaml` into its layer. If not: routes only |
| p44                 | project yaml `registry: {B}`, `~/.npmrc` token U                                                                            | A yaml route picks up a user-layer credential (expect `Bearer U`)                                                                    |
| p45                 | `config.yaml` `registry: {B}`, `auth.ini` token G                                                                           | Same, for a global route                                                                                                             |
| p50                 | `XDG_CONFIG_HOME` unset; `~/Library/Preferences/pnpm/auth.ini` `registry={B}`                                               | macOS default directory, `auth.ini`                                                                                                  |
| p51                 | `XDG_CONFIG_HOME` unset; `~/Library/Preferences/pnpm/config.yaml` `registry: {B}`                                           | macOS default directory, `config.yaml`                                                                                               |
| p52                 | `XDG_CONFIG_HOME` unset; `~/.config/pnpm/auth.ini` `registry={B}`                                                           | Not read on macOS (expect npmjs)                                                                                                     |
| p53                 | `XDG_CONFIG_HOME=relcfg`; `{PROJECT}/relcfg/pnpm/auth.ini` `registry={B}`                                                   | Is a relative XDG path used, against cwd? → `pnpmConfigDir`                                                                          |
| p54                 | `$XDG/pnpm/rc` `registry={B}`                                                                                               | The legacy `rc` is not read (expect npmjs)                                                                                           |
| p55                 | `PREFIX={HOME}/prefix`, `prefix/etc/npmrc` `registry={B}`                                                                   | npm's global npmrc is not read (expect npmjs)                                                                                        |
| p60 _(record-only)_ | project `.npmrc` `strict-ssl=false` / `fetch-timeout=1`, `args: ['config','get',…]`                                         | Does pnpm 12 still read non-auth `.npmrc` keys? A divergence becomes a new issue (decision 1)                                        |

If any outcome contradicts #117's stated precedence, stop and report it before implementing.

**2b. Regression tests, written first and seen failing on the Phase-1 commit**

New `__tests__/managers/pnpmNpmrc.test.ts`, on temp dirs with injected sources and `jest.mock('@/utils/logger')`. Build the config through `mergeNpmrcLayers(pnpmNpmrcLayers(cwd, sources))` and `registryConfigFrom`, and assert with `registryFor` and `credentialsFor` / `authorizationFor`.
- **#117 Evidence rows 1–8, one test each.** Row 6 asserts the default registry or the lower layer, per p30. Row 7 asserts that no credential reaches the host. Row 8 covers both `~/.npmrc` and `config.yaml`.
- **One test per probe decision:** p20–p26, p30–p36, p40–p45 and p50–p55.
- **Config directory per platform:**
  - darwin with no XDG: `~/Library/Preferences/pnpm`;
  - linux with no XDG: `~/.config/pnpm`;
  - win32: `%LOCALAPPDATA%\pnpm\config`, else `~/.config/pnpm`;
  - XDG set: `$XDG_CONFIG_HOME/pnpm`, relative per p53.
  - linux and win32 cite the source-read in the test name.
- **From a member,** the yaml and `.npmrc` are the nearest `pnpm-workspace.yaml` ancestor's, and a member's own `.npmrc` is ignored. Port the existing member assertions.

`__tests__/managers/pnpmRegistries.test.ts`:
- keep the parser tests unchanged;
- remove the `applyPnpmRegistrySettings` tests, whose cases move into `pnpmNpmrc.test.ts` as layer tests;
- add `env`-option tests: global `config.yaml` values expand, while project ones keep ignoring `${…}`.

`__tests__/project.test.ts`: spy `pnpm.npmrcLayers` in place of `registryConfig`.

**2c. Implementation**
- New `src/managers/pnpm/npmrc.ts`:
  - `pnpmProjectRoot(cwd)`, moved from `index.ts` and exported;
  - `pnpmConfigDir(sources)`;
  - `PNPM_ENV: EnvRule`;
  - `pnpmNpmrcLayers(cwd, sources)`, returning the six layers in the table order;
  - a private `yamlRouteLayer(file, settings)` that turns `PnpmRegistrySettings` into `{ kind: 'file', file, values }` with only the keys that are set.
- `src/managers/pnpm/registries.ts`:
  - `pnpmRegistrySettings(yaml, { env }: { env?: NodeJS.ProcessEnv } = {})`. With `env`, values are substituted (the flavor from p34) before `usable()`; without it, `${…}` is ignored as now.
  - Delete `applyPnpmRegistrySettings`, and update the file's doc comments ("Not read yet …" goes).
- `src/managers/pnpm/index.ts`: `npmrcLayers: pnpmNpmrcLayers`; drop `registryConfig` and `projectRoot`; import `pnpmProjectRoot` if still needed.

**2d. Docs (in PR A)**
- **Root `CLAUDE.md`:**
  - Rewrite the `npmrcLoader.ts` bullet: each manager's layers, highest first, merged per key with each key's origin (`mergeNpmrcLayers`); npm's as before; one sub-bullet per manager. bun and yarn v1 read "npm's layers until #118" and "until #122".
  - Fix the trailing sentence: bunfig.toml is read since #119; only berry's `.yarnrc.yml` is not.
  - Add `npmrcLayers` / `registryConfig` to the adapter-members list in "Pipeline and manager adapters".
- **`src/utils/CLAUDE.md`:**
  - Tree lines for `npmrc.ts` (`parseNpmrc(text, env, substitute?)`) and `npmrcLoader.ts` (layers, merge, view).
  - In "Registry / .npmrc": the `loadNpmrc` bullet; replace the `projectRoot?` bullet with `npmrcLayers?`; update the `registryConfig?` bullet with the view argument.
  - Rewrite the pnpm sub-bullet with the full layer order, env naming, `${VAR}` rules and config directory, each with its verification.
  - Split the "Limitation:" bullet into per-manager "not read" sub-bullets, and remove pnpm's three items.
- **`src/managers/CLAUDE.md`:** the adapter member list (`npmrcLayers?` replaces `projectRoot?`), and the tree (`pnpm/npmrc.ts`; `pnpm/registries.ts` is the parser only).
- **`.claude/context/ai-context/docs-overview.md`:** add `__tests__/utils/npmrcLayers.test.ts` and `__tests__/managers/pnpmNpmrc.test.ts`, plus the existing `pnpmRegistries.test.ts`, `bunfig.test.ts` and `yarnrc.test.ts` if missing.

**2e. Gates and real run:** the five gates. Then paired runs of #117 rows 1–8, plus p22, p31, p40, p41 and p44, as the PR's Real run table (manager versus autd: server and Authorization). Not verified: the Linux and Windows config directories (source-read).

### Phase 3 — bun (PR B, closes #118; branch from `main` after PR A merges)

**3a. Probes first.** `cases-bun-layers.cjs`; route and credential cases are `paired(c, 'bun')`.

| Id  | Setup                                                                                         | Settles → decision                                                                                           |
| --- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| b20 | `$XDG/.npmrc` exists and is empty; `~/.npmrc` `registry={A}`                                  | "Exists" means the file exists, empty included (expect npmjs) → existence check, not content                 |
| b21 | `XDG_CONFIG_HOME=relcfg`, `{PROJECT}/relcfg/.npmrc` `registry={B}`, `~/.npmrc` `registry={A}` | Relative XDG: used against cwd or ignored → absolute-only, as `globalBunfig`, or not                         |
| b22 | `NPM_CONFIG_USERCONFIG={HOME}/alt.npmrc` (`registry={B}`)                                     | Does bun honor userconfig? (expect no)                                                                       |
| b23 | `$XDG/.npmrc` `//{BH}/:_authToken=X`, project `.npmrc` `registry={B}`                         | Credentials from the XDG file (expect `Bearer X`)                                                            |
| b24 | `$XDG/.npmrc` token X, `~/.npmrc` token Y (same host), project `registry={B}`                 | `~/.npmrc` is never read while XDG exists (expect X)                                                         |
| b25 | project `.npmrc` token P, `$XDG/.npmrc` token X                                               | Project beats the user file per key (expect P)                                                               |
| b26 | `npm_config_@acme:registry={B}`, project `.npmrc` `@acme:registry={A}`                        | Does bun read scoped env? (expect A) → whether bun has an env layer at all                                   |
| b27 | `npm_config_//{BH}/:_authToken=E`, project `registry={B}`                                     | Does bun read env credentials? (expect none)                                                                 |
| b28 | `NPM_CONFIG_TOKEN=E`, project `.npmrc` `registry={B}` + `//{BH}/:_authToken=T2`               | `NPM_CONFIG_TOKEN` against an `.npmrc` token (b4c covered only `BUN_CONFIG_TOKEN`) → `bunfig.ts` token order |
| b29 | `BUN_CONFIG_TOKEN=E`, project `.npmrc` `registry={B}`, no bunfig                              | The env token on an `.npmrc` default route                                                                   |
| b30 | project `.npmrc` `registry={B}` + `//{BH}/:_authToken=$TOK` (`TOK` set)                       | `$VAR` without braces in `.npmrc`? → a bun `Substitute` (`${VAR}` plus `$VAR`), else `substituteEnv`         |
| b31 | project `.npmrc` `//{BH}/:_authToken=${UNSET}`, `registry={B}`                                | Unset: no auth or a literal (autd keeps dropping it; record)                                                 |
| b32 | `PREFIX={HOME}/prefix`, `prefix/etc/npmrc` `registry={A}`                                     | npm's global npmrc is not read (expect npmjs)                                                                |
| b33 | `.npmrc` `registry={A}` in a parent of the project (`cwd: 'sub'`, `sub/package.json`)         | Does bun read a parent's `.npmrc`? (expect no)                                                               |

If b26 or b27 show bun reads more of `npm_config_*` than the registry and token variables, add an env layer whose `key()` keeps only what bun reads.

**3b. Regression tests first.** New `__tests__/managers/bunNpmrc.test.ts`:
- **#118 Evidence rows 1–5, one test each.** Rows 2 and 5 already pass; keep them as guards.
- **One test per probe decision.**
- **What bun no longer reads:** `<prefix>/etc/npmrc`, npm's builtin npmrc, and `npm_config_userconfig`.
- **From a member,** the root's `.npmrc` is read and the member's is ignored.
- **End to end,** `bunRegistryConfig` over the new view still puts `BUN_CONFIG_REGISTRY` and bunfig routes above `.npmrc`. `bunfig.test.ts` stays as it is; it passes `base()` objects.

**3c. Implementation**
- New `src/managers/bun/npmrc.ts`:
  - `bunUserNpmrc(sources)`: `$XDG_CONFIG_HOME/.npmrc` when XDG is set (absolute only if b21 says so) and `fs.statSync(file, { throwIfNoEntry: false })?.isFile()`, else `path.join(home, '.npmrc')`;
  - `bunNpmrcLayers(cwd, sources)`: `[project, user]`, plus an env layer only if b26 or b27 require one.
- `src/managers/bun/index.ts`: `npmrcLayers: bunNpmrcLayers`.
- `bunfig.ts`:
  - update `bunRegistryConfig`'s doc comment (the "Not read yet" sentence goes);
  - adjust the token order only if b28 or b29 contradict it;
  - the default registry's `fromEnv` keeps reading `BUN_CONFIG_REGISTRY` / `NPM_CONFIG_REGISTRY` / `npm_config_registry` directly. They no longer reach `base` through an npm env layer, so `fromEnv` alone carries them; b3a–b3e still hold.

**3d. Docs:**
- the bun sub-bullet in the root `CLAUDE.md`;
- the bun sub-bullet and bun's "not read" entry in `src/utils/CLAUDE.md`;
- `bun/npmrc.ts` in `src/managers/CLAUDE.md`'s tree;
- `bunNpmrc.test.ts` in docs-overview.

**3e. Gates and real run:** the five gates. Paired runs of #118 rows 1–5, plus b23, b24 and b32.

### Phase 4 — yarn v1 (PR C, closes #122; branch from `main` after PR A merges)

**4a. Probes first.** `cases-yarn-layers.cjs`:
- use a scoped `@acme` route wherever credentials matter: yarn 1 sends auth for scoped packages;
- member cases use the `WS` / `member()` helpers from `cases-yarn.cjs` with `cwd: 'packages/app'`;
- parent cases put the project in `sub/` (`cwd: 'sub'`), so the harness's `project/` directory is the parent;
- route and credential cases are `paired(c, 'yarn')`.

| Id                  | Setup                                                                                                            | Settles → decision                                                                                                                  |
| ------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| y20                 | member `.npmrc` `//{BH}/:_authToken=M`, root `.npmrc` `//{BH}/:_authToken=R` + `@acme:registry={B}`; member cwd  | Credentials follow the same layering (expect `Bearer M`)                                                                            |
| y21                 | `~/.npmrc` token H, root token R, root routes `@acme` → B; member cwd                                            | Home before root (expect H)                                                                                                         |
| y22                 | root-only token R, member `.npmrc` `@acme:registry={B}`; member cwd                                              | A parent fills the key a nearer file lacks (expect R)                                                                               |
| y23                 | parent `.npmrc` `registry={A}`, `sub/.yarnrc` `registry "{B}"`; cwd `sub`                                        | The comment's example: a parent `.npmrc` beats `.yarnrc` (expect A)                                                                 |
| y24                 | parent `.npmrc` `@acme:registry={A}`, `~/.npmrc` `@acme:registry={B}`; cwd `sub`                                 | Home before parents (expect B)                                                                                                      |
| y25                 | parent `.npmrc` `@acme:registry={A}` + `//{AH}/:_authToken=P`; cwd `sub`                                         | Credentials from a parent (expect `Bearer P`)                                                                                       |
| y26                 | `PREFIX={HOME}/prefix`, `prefix/etc/npmrc` `@acme:registry={B}`, parent `.npmrc` `@acme:registry={A}`; cwd `sub` | The prefix file, between home and the parents (expect B)                                                                            |
| y27                 | `~/.npmrc` `@acme:registry={A}`, `prefix/etc/npmrc` `@acme:registry={B}`                                         | Home before prefix (expect A)                                                                                                       |
| y28                 | `npm_config_userconfig={HOME}/alt.npmrc` (`@acme:registry={B}`), `~/.npmrc` `@acme:registry={A}`                 | userconfig from env (expect B); the path is resolved against cwd, with no `~` expansion (per yarn's source)                         |
| y29                 | `npm_config_//{BH}/:_authToken=E`, `.npmrc` `@acme:registry={B}`                                                 | yarn's env normalization (lower-casing, `_` → `-`, `.` nesting) drops env credentials (expect none)                                 |
| y30                 | `NPM_CONFIG_@ACME:REGISTRY={B}`                                                                                  | An upper-case scope from env (expect B)                                                                                             |
| y31                 | member `.npmrc` `//{BH}/:_authToken=${TOK}` (`TOK` set), routes to B                                             | `${VAR}` expanded in `.npmrc` → file `substitute`                                                                                   |
| y32                 | the same with `TOK` unset                                                                                        | yarn fails with "Failed to replace env in config"? Record; autd keeps the literal and drops the credential, since yarn itself fails |
| y33 _(record-only)_ | `package.json` with only `probe-unscoped`; `.npmrc` `registry={B}` + `//{BH}/:_authToken=T`                      | Unscoped packages get no auth without `always-auth` → a new issue if confirmed (decision 1)                                         |
| y34 _(record-only)_ | y33 plus `always-auth=true`                                                                                      |                                                                                                                                     |
| y35 _(record-only)_ | bare `_authToken=U`, `.npmrc` `@acme:registry={B}`                                                               | Is a bare `_authToken` sent? → decision 1                                                                                           |
| y36 _(record-only)_ | root cwd, `args: ['workspace','app','upgrade']`, member `.npmrc` `@acme:registry={B}`, root `@acme` → A          | yarn reads the member's file in a per-member upgrade → decision 1                                                                   |

The filesystem root `/.npmrc` can't be written safely. Yarn's source says it is not read, which matches the probed `.yarnrc` rule; test it with the `readFileSync` spy that `yarnrc.test.ts` uses.

**4b. Regression tests first.** New `__tests__/managers/yarnNpmrc.test.ts`, with a tmp `execPath` and `home`. Build through `mergeNpmrcLayers(yarnNpmrcLayers(...))` and `registryConfigFrom`, then `yarnRegistryConfig(cwd, base, sources, view)`.
- **#122 Evidence rows 1 and 2.**
- **The comment's example:** a parent `.npmrc` beats a project `.yarnrc`.
- **Probes y20–y31, one test each.**
- **The filesystem root `.npmrc` is not read** (the spy technique from `yarnrc.test.ts`, "the filesystem root"; take the root from the project dir, not `process.cwd()`, which broke Windows in #124).
- **Berry keeps npm's layers:** `yarn.npmrcLayers` with a `.yarnrc.yml` returns `npmNpmrcLayers`'s result.

`__tests__/managers/yarnrc.test.ts`:
- `configFor` builds the yarn view as above, with a tmp `execPath`, so the real Node prefix's `etc/npmrc` can't leak into the test;
- every existing assertion stays;
- add "reads each `.npmrc` once / `loadNpmrc` not called" (spy on `npmrcLoader.loadNpmrc`).

**4c. Implementation**
- New `src/managers/yarn/npmrc.ts`:
  - `YARN_NPM_ENV: EnvRule`: prefix `/^npm_config_/i`; `key(rest)` lower-cases, replaces `__` → `.` and `([^_])_` → `$1-`, and returns undefined for a key holding `.`, which yarn's `objectPath.set` would nest; `substitute` per y31.
  - `yarnNpmrcLayers(cwd, sources)`, in this order:
    1. env;
    2. `<cwd>/.npmrc`;
    3. the user file: `env.values.userconfig` resolved against cwd when it is a string, else `path.join(home, '.npmrc')`;
    4. `path.join(nonEmpty(env.PREFIX) ?? execPrefix(sources), 'etc', 'npmrc')`;
    5. each parent's `.npmrc`, nearest first, without cwd and without the filesystem root.
- `src/managers/yarn/yarnrc.ts`:
  - export the ancestor walk as `ancestorFiles(cwd, name)`, reused by both modules;
  - `yarnRegistryConfig(cwd, base, sources, npmrc: NpmrcView)` drops its `loadNpmrc` call and import;
  - `const set = nonEmpty(npmrc.values.registry)`; `usable = set !== undefined && isRegistryUrl(set)`; `fromEnv = usable && npmrc.origin('registry')?.kind === 'env'`;
  - in the existing chain, replace `(npmEnv ? base.registry : undefined)` with `(fromEnv ? base.registry : undefined)`, and `npmrcHasRegistry` with `usable`. `envRegistry` stays for `yarn_registry` only. This is equivalent to today for valid, invalid and empty env values;
  - update the doc comment's "Not read" list (the member `.npmrc` sentence goes).
- `src/managers/yarn/index.ts`:
  - `npmrcLayers: (cwd, s) => isYarnBerry(cwd) ? npmNpmrcLayers(cwd, s) : yarnNpmrcLayers(cwd, s)`;
  - `registryConfig` passes the view through.

**4d. Docs:**
- the yarn v1 sub-bullet in the root `CLAUDE.md`;
- the yarn v1 sub-bullet in `src/utils/CLAUDE.md`, with the `.npmrc` order and env normalization;
- update its "not read" list (root-user `/usr/local/share` home, `DESTDIR`, `/.npmrc`, `${VAR?}`);
- `yarn/npmrc.ts` in `src/managers/CLAUDE.md`'s tree;
- `yarnNpmrc.test.ts` in docs-overview.

**4e. Gates and real run:** the five gates, with yarn through Corepack shims first on PATH (`corepack enable --install-directory <scratchpad>/shims yarn`). Paired runs of #122 rows 1 and 2, the comment's example (y23), and y20–y22 and y25.

## Design Considerations

- **Performance.** The extra reads run once per run, on the session's first `registryConfig()`, and are noise next to the network:
  - pnpm reads up to two more small files (`config.yaml`, `auth.ini`);
  - yarn v1 reads one `.npmrc` per ancestor (path depth, typically 5–8 stats);
  - bun reads one file fewer.
- **Startup.** The new modules load with the adapters but do no I/O at import. `startup.test.ts` guards the client and reader, and `project.test.ts` guards that neither hook runs in `openProject`.
- **Windows.**
  - Every path goes through `path.join` / `path.resolve` from injected `NpmrcSources`.
  - Layer tests pass `platform` explicitly, and Windows-only rules (pnpm's `LOCALAPPDATA`) are unit-tested on an injected `win32`.
  - The windows-latest CI job runs the unit suite and the matrix.
  - Take any filesystem root from the path under test, never `process.cwd()`: the checkout and the temp dir sit on different drives (#124).
- **Security.** Not expanding `${VAR}` in pnpm's project files is the point of #117 row 7: a repository's `.npmrc` must not turn an environment secret into a header sent to a host the repository chose.

## Risks & Mitigation

- **A probe outcome the seam can't express.** All three probe sets run before PR A is finalized, and the seam's parameters (`EnvRule.key`, `substitute`, null semantics) cover every branch above. If something still breaks the seam, change it in that phase's PR, with `npmrcLoader.test.ts` still unedited.
- **npm drift.** Ruled out by the unedited loader tests, the unedited `singlePackageJson` snapshot, and the matrix's npm rows. Review the `npmNpmrcLayers` diff as a move, not a rewrite.
- **Machine leakage in tests.** The yarn layers read `${execPrefix}/etc/npmrc` and every ancestor's `.npmrc`. New and updated tests use a tmp `execPath` and `home`; ancestors of `os.tmpdir()` are the same exposure the `.yarnrc` tests already accept.
- **CI environment.** pnpm now ignores `npm_config_*` (for example `npm_config_userconfig` from `actions/setup-node`), which matches pnpm. The matrix runs against the public registry, so its expectations don't change.
- **Not verifiable here** (list each under the PR's Not verified):
  - pnpm's Linux and Windows config directories (decision 2);
  - bun's and yarn's Windows user paths (the unit tests use injected sources);
  - yarn's root-user home on Linux and `DESTDIR`, documented as not read.
- **Fallback.** Each manager's layers are one adapter property. If a manager's layering misbehaves after release, deleting `npmrcLayers` from that adapter restores npm's view for it alone.

## Files

- **Seam:** `src/utils/npmrcLoader.ts`, `src/utils/npmrc.ts`, `src/managers/adapter.ts`, `src/project.ts`.
- **pnpm:** `src/managers/pnpm/npmrc.ts` (new), `src/managers/pnpm/registries.ts`, `src/managers/pnpm/index.ts`.
- **bun:** `src/managers/bun/npmrc.ts` (new), `src/managers/bun/bunfig.ts`, `src/managers/bun/index.ts`.
- **yarn:** `src/managers/yarn/npmrc.ts` (new), `src/managers/yarn/yarnrc.ts`, `src/managers/yarn/index.ts`.
- **Tests:**
  - new: `__tests__/utils/npmrcLayers.test.ts`, `__tests__/managers/pnpmNpmrc.test.ts`, `__tests__/managers/bunNpmrc.test.ts`, `__tests__/managers/yarnNpmrc.test.ts`;
  - changed: `__tests__/managers/pnpmRegistries.test.ts`, `__tests__/managers/yarnrc.test.ts`, `__tests__/project.test.ts`;
  - unchanged, as proof: `__tests__/utils/npmrcLoader.test.ts`, `__tests__/utils/npmrc.test.ts`, `__tests__/startup.test.ts`.
- **Docs:** `CLAUDE.md`, `src/utils/CLAUDE.md`, `src/managers/CLAUDE.md`, `.claude/context/ai-context/docs-overview.md`.
- **Probe harness:** `<scratchpad>/registry-probe/run.cjs` and `serve.cjs`; existing results in `<scratchpad>/registry-probe/results.jsonl`.
