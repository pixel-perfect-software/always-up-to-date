# Feature Implementation Plan: Native discovery for npm, pnpm, yarn v1 and bun

Issue: #106 (also closes #95). Milestone: M3. Planned 2026-10-26 against `feat/105-registry-reader` (PR #116). Both PRs below branch from `main` after #116 merges.

- [x] Phase 1: Registry settings from pnpm-workspace.yaml and bunfig.toml (PR A, `feat/106-registry-settings`; blocked by D2)
- [x] Phase 2: Registry captures and the pure building blocks (PR B, `feat/106-native-discovery`)
- [x] Phase 3: One native discovery in the pipeline (PR B; blocked by D1 and D3)
- [x] Phase 4: Delete the `outdated` parsers, their fixtures and dead helpers; docs (PR B)
- [x] Phase 5: Real-run gates, then the PR (#121) (PR B; D6 sets the pass bar and the release)

Rules for every phase:
- Each phase leaves `pnpm run check-types`, `pnpm run format-and-lint`, `pnpm test` and `pnpm run build` green.
- Don't commit; the orchestrator commits per phase. Commit subjects are suggested per phase.
- PR A and PR B are independent off `main`. PR A should merge first, or at least before the release.
- They conflict only in `src/managers/adapter.ts`, `src/types.ts` and the docs. Merge `main` into the second one before handover.

Planning limits: no real runs were made while planning. Issue text came from github.com through WebFetch summaries (`gh` was not available).

## Open decisions (answer before the phase each one blocks)

**Decided by the user, 2026-10-26: every recommendation.** D1: one reviewed snapshot change in its own commit. D2: Phase 1 as its own PR first (PR A); the listed left-outs become follow-up issues. D3: a failed lookup fails the run. D6: accept the warm pnpm/bun regression in PR B, record both tables, and cut no release between #106 and #108.

### D1. The single-package snapshot can't stay byte-identical (blocks Phase 3)

`__tests__/singlePackageJson.test.ts` runs the four managers' captured `outdated` output (`*/outdated-alias*.stdout`, `pnpm/outdated-alias-compatible.stdout`) through `check`, `plan` and `update`. #106 deletes those parsers and fixtures, and native discovery has no manager output to pass through.

10 of the 24 entries can stay byte-identical: npm `plan` and `update` (4), and all 6 bun entries. These 14 must change:
- **npm `check` (2).** npm's own fields `dependent` and `location` disappear. The key order becomes `name, current, wanted, latest`.
- **pnpm, all 6.** `check` loses `isDeprecated` and `dependencyType`. Every list is sorted by name; pnpm had printed dj, semver, express, zod.
- **yarn, all 6.** The `dj` alias row gets dayjs's real versions (1.11.9 / 1.11.9 / 1.11.23) instead of yarn v1's `exotic`. By default it is held with `patch beyond the range`; under `beyondRange: major` it moves to 1.11.23.

After the change, all four managers print identical bytes. Users also see this: `check --json` loses those pass-through fields in single-package npm and pnpm projects. It goes in the changelog.

- **Recommended: one reviewed snapshot change, in its own commit.**
  - The test keeps its manifest and its purpose.
  - Its input becomes captured registry bodies, derived "as of" the date the snapshot was captured (so no version value drifts), plus a written `node_modules`.
  - It also asserts that the four managers' JSON is identical.
  - The PR lists the 14 entries and why each changed. From then on the snapshot is pinned again.
- **(b)** Delete the test and the snapshot, and keep only shape tests.
- **(c)** Keep the parsers for this one test. That contradicts the issue.

### D2. Registry settings outside `.npmrc` (blocks Phase 1; widens scope)

Evidence from the docs, read 2026-10-26:

- **pnpm 12** (pnpm.io/settings): "Only auth and registry settings are read from `.npmrc` files. All other settings are configured in `pnpm-workspace.yaml` or the global `config.yaml`."
  - `pnpm-workspace.yaml` takes `registry` and, since 11.23.0, `registries`. That is either URL-keyed entries with `scopes: [...]` (where `"@"` is the default registry) or the older map of `default` / `"@scope"` → URL. The two shapes can't be mixed.
  - Credentials are refused in that file; they stay in `.npmrc`. Values containing `${…}` are ignored since 11.5.3.
  - `pnpm login --scope` (12.1.0+) writes its routes to the global `config.yaml`. A `.npmrc` registry outranks those routes (12.4.0).
  - The docs don't say whether the project's `pnpm-workspace.yaml` or `.npmrc` wins.
- **bun 1.4** (bun.com/docs/pm/npmrc, /runtime/bunfig): sources apply in this order, later wins:
  1. the user `.npmrc`;
  2. the project `.npmrc`;
  3. `bunfig.toml`, global then project;
  4. `BUN_CONFIG_REGISTRY` / `NPM_CONFIG_REGISTRY`, and `BUN_CONFIG_TOKEN` / `NPM_CONFIG_TOKEN`;
  5. flags.
  - `[install] registry` is a URL, a URL with `user:pass@`, or `{ url, token }`.
  - `[install.scopes]` entries take the same forms, plus `{ url, username, password }`.
  - `$variable` expands environment variables.

Why it matters: today each manager's `outdated` reads all of this. Once discovery is native, a scope routed only in `pnpm-workspace.yaml` or `bunfig.toml` is sent to registry.npmjs.org. It 404s there and, under D3, fails `check`. Cooldown already has this gap, but cooldown fails open.

- **Recommended: Phase 1 as its own PR.** It reads registry URLs, scope routes and (for bun) credentials from those files. Precedence is settled by real runs, not by guesswork. It also fixes cooldown for these projects.
- **Left out either way, each a follow-up issue:**
  - pnpm's global `config.yaml` routes;
  - `pnpm_config_*` environment variables;
  - pnpm's named-registry prefixes (`gh:`, `npmjs:`, a `prefix:` spec), which discovery skips;
  - yarn v1's `.yarnrc`;
  - bun's `$XDG_CONFIG_HOME/.npmrc`, and the fact that bun doesn't read the global npmrc that autd's loader layers in.
- **Alternative:** defer all of it to a new issue. PR B then ships with the gap documented, and the failure message names the host autd asked.

### D3. How a failed lookup surfaces (blocks Phase 3)

- **Recommended: a failed lookup fails the run.**
  - Discovery waits for every lookup to settle.
  - Any `ok: false` then becomes one `StepError('discover')`. Its message names each failed package with its reason: the first 10, then "and N more".
  - The command exits 1, or prints the `--json` error object. That is what happens today when `<pm> outdated` fails; npm, pnpm and berry's `yarn npm info` already fail the whole command on an unknown package.
  - Why not report it per package: `check --json` has no field for a reason until M4's versioned schema ("reasons on every row"). A package left out reads as up to date, which the project's failure rules forbid.
  - Transient errors are already retried by the client (`fetch-retries`), and deps.dev failures fall back inside the reader.
  - Specs that never reach the registry are skipped before any lookup, so they are not failures.
- **Alternative:** a `not-found` becomes a warning (on stderr under `--json`) and the package is left out. A `request` or `invalid` failure still fails the run.

### D6. pnpm and bun get slower on a warm `check` until #108 (sets Phase 5's bar and the release)

- On the M3 baseline, pnpm's warm `check` takes 0.25 s and bun's 0.16–0.17 s. That speed comes from the manager's own metadata cache.
- Native discovery has no cache until #108, so every run pays the network round trips. The roadmap's prototype took about 0.6 s for the 40 packages.
- npm (0.92 s warm), yarn v1 (2.65 s) and every cold run should get faster.
- **Recommended:** accept the warm regression in PR B, record both tables in the PR, and cut no release between #106 and #108.
- **Alternative:** land #108 first. It's independent of #106, because the cache sits behind `RegistrySession.lookup`.

## Decisions made in planning (confirm or veto)

1. **One native discovery, with one exception.** Adapters lose `discover`. Yarn berry alone keeps its `yarn info` discovery, through an optional `ownDiscovery(cwd)` hook, until #107 removes it.
2. **Fields discovered: `dependencies`, `devDependencies`, `optionalDependencies`.**
   - When a name appears in several fields, the first field wins, in `readSpec`'s order.
   - A name declared only in `peerDependencies` is not discovered. A peer range is the package's contract with its consumers, and yarn v1's apply can't write it (`DESCRIPTOR_FIELDS`).
   - Phase 3 starts by recording what each manager's `outdated` lists for a peer-only dependency. If npm or bun list them, the PR says autd no longer does.
3. **Installs without `node_modules`.**
   - No root `node_modules`, with at least one registry dependency declared: `StepError('discover')` telling the user to run `<pm> install`. #107 replaces this with lockfile reading.
   - A declared non-optional dependency with no installed copy: a row with `current: 'missing'`. That is npm's existing convention, and the policy holds it.
   - A missing optional dependency: skipped, with a debug line. Platform-only optional packages are normal.
4. **Workspace packages are skipped.**
   - Skip a dependency whose installed copy is a symlink (or Windows junction) to a directory inside the project and outside every `node_modules`.
   - Also skip a dependency that isn't installed and whose name is a workspace member's.
5. **Specs that are skipped, each with a debug line:**
   - `workspace:`;
   - anything still containing `:`, `/` or `#` after alias and catalog resolution: git, file, link and URL specs, github shorthand, pnpm prefixes. This is the writers' own test (`nextVersionSpec`);
   - `npm:<name>` with no range.
   - A spec of `latest` gets wanted = the registry's `latest`.
   - Any other dist-tag and an unknown `catalog:` reference are skipped with a warning, not a debug line, because they would otherwise read as up to date.
6. **`wanted` can be below `current`,** for example when a deprecated version is installed. It is reported as computed. The policy never targets a version at or below `current`, and `rows.ts` shows the "in range" note only when `wanted` is ahead of `current`.
7. **A row is listed when** `current` is `missing`, or `latest > current`, or `wanted > current`.
8. **Order.**
   - Single-package: keys sorted by name in code-unit order, as berry's discovery sorts.
   - Workspace: entries by name, then the root first, then by path.
9. **`Workspace.catalogs` holds the catalog contents,** `Record<catalog, Record<name, spec>>`, with `default` for `catalog:` and `catalog:default`. They are read by the same line walk the writers use. The log line prints the names, so it shows `default` where it showed `catalog`.
10. **Large captures are gzipped.**
    - Registry captures over 100 KB decoded are committed gzipped, as `<name>.<kind>.body.gz`; the bytes are verbatim once gunzipped.
    - `.gitattributes` gets `*.gz binary`.
    - Measured 2026-10-26: deps.dev's bodies for next and typescript are about 700 KB decoded each, pnpm's 237 KB, yarn's about 20 KB.
11. **Both sources in the edge tests.** The yarn and pnpm edge cases each run on deps.dev and on the abbreviated packument, the two sources the reader can produce.
12. **What stays and what goes.**
    - `readLockedVersions` (npm adapter), its fixture `npm/no-node-modules.package-lock.json` and its tests stay; they are #107's input.
    - `workspaceOwner`, `toManifestNames`, `toEntryManifestNames` and `src/utils/manifestNames.ts` go. `DEPENDENCY_FIELDS` moves to `src/utils/dependencySpecs.ts`.
13. **`wantedVersion` takes `{ preferLatest }` now,** default `true` and tested. It is berry's switch in #107, as the roadmap describes.
14. **One debug line per run:** how many lookups, the time they took, and how many came from deps.dev versus a packument.

## Overview

**Goal.** `check`, and `update`'s discovery, dry-run and interactive mode, find versions for npm, pnpm, yarn v1 and bun with no package-manager subprocess. They read the manifests, `node_modules` and #105's registry reader. Every manager gets the same `wanted` rule, computed per manifest. The manager is used only for apply.

**Acceptance criteria**
1. **No subprocess during `check`** for npm, pnpm, yarn v1 or bun.
   - A unit test per manager asserts `runProcess` is never called.
   - The integration matrix runs its first `check --json` with no package manager on PATH.
2. **The matrix passes unchanged.** `pnpm run test:integration` passes for npm, pnpm, yarn and bun, and for berry on its unchanged path, with `__tests__/integration/expectations.ts` untouched.
3. **#95 no longer reproduces.**
   - The setup: pnpm workspace rows that share a version — root `dayjs ~1.10.0` and `packages/m ^1.10.0`, both at 1.10.0.
   - The result: each row gets its own `wanted` (1.10.8 and the registry's `latest`).
   - Shown by a unit regression test, and by a real pnpm 12 run comparing `main` with the branch.
4. **One discovery:** `discoverFromRegistry` in `src/discovery.ts`, called by the pipeline. Only yarn berry bypasses it, through `ownDiscovery`.
5. **Specs come from every manifest** (root, workspace members, catalogs), through the readers apply's writers use:
   - `readSpec`'s field order;
   - for pnpm catalogs, `updatePNPMWorkspaceYAML`'s line walk;
   - for bun catalogs, `updateBunCatalogs`'s fields.
6. **Specs and aliases.** Non-registry specs are skipped. An `npm:` alias is looked up by its target and reported under its manifest key.
7. **Installed versions come from `node_modules`** through `src/utils/installed.ts`.
8. **Published versions come from `RegistrySession.lookup`** (#105).
9. **`wanted`, per manifest:**
   1. an exact pin is its own version;
   2. otherwise `latest`, when it satisfies the range and isn't deprecated;
   3. otherwise the highest satisfying version that isn't deprecated;
   4. otherwise the highest satisfying version.
      Prereleases follow semver's default.
10. **Edge tests on captured registry documents:**
    - `yarn`: `latest` 1.22.22 is below 2.4.3, which is stable and tagged `berry`;
    - `pnpm@~5.18.0`: 5.18.11 is deprecated, so wanted is 5.18.10.
11. **The `outdated` parsers and their fixtures are deleted** for npm, pnpm, yarn v1 and bun.
12. **Shape and startup.**
    - `check --json` keeps its shape: name keys, plus `workspaces: [{ path, current, wanted }]` in a workspace. D1 covers the snapshot.
    - `__tests__/startup.test.ts` passes, and no new eager imports are added.
13. **Performance:** `pnpm run bench` compares `main` with the branch for npm, pnpm, yarn and bun (Phase 5, bar set by D6).
14. **Phase 1, if D2 is accepted:** registry URLs and scope routes from `pnpm-workspace.yaml` and `bunfig.toml` reach the reader and the cooldown, with the precedence a real run showed.

**Out of scope**
- #107: yarn berry discovery, and installed versions from lockfiles when there is no `node_modules`.
- #108: the disk cache.
- #47: cooldown on the reader. `computeReleaseAges` and `releaseTimes` stay as they are.
- M4: npm also skips versions whose `engines` exclude the running Node; this plan's `wanted` doesn't.
- Dist-tags other than `latest`.

## Technical Architecture

No new dependencies. The design uses `semver` 7.8.5 (the catalog's `^7.8.5`):
- `satisfies`, `valid`, `validRange`, `compare` and `prerelease` already appear in the repo.
- `clean` is checked against the npm/node-semver README: `clean('=v2.1.5')` is `'2.1.5'` and `clean('~1.0.0')` is `null`.
- Prerelease matching, from the same README: a prerelease satisfies a range only when a comparator with the same `[major, minor, patch]` also has a prerelease. `includePrerelease` is not used.

### Modules

| File                                   | Change            | Holds                                                                                                                                                                                 |
| -------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/discovery.ts`                     | new               | `discoverFromRegistry(input): Promise<Discovery>`                                                                                                                                     |
| `src/utils/wanted.ts`                  | new               | `wantedVersion(range, pkg, { preferLatest })`, pure                                                                                                                                   |
| `src/utils/dependencySpecs.ts`         | new               | `DEPENDENCY_FIELDS` (moved), `DISCOVERED_FIELDS`, `Catalogs`, `classifySpec()`, `readDeclaredDependencies()`                                                                          |
| `src/utils/files.ts`                   | changed           | `readPnpmCatalogs(yaml)`, `readBunCatalogs(manifest)`. `updatePNPMWorkspaceYAML` rewritten on a shared line walk with unchanged output. `readSpec` uses the moved `DEPENDENCY_FIELDS` |
| `src/utils/installed.ts`               | changed           | `readInstalledPackages(cwd, rows)` returns `{ version, linked }`; `readInstalledVersions` builds on it                                                                                |
| `src/utils/rows.ts`                    | changed           | The in-range note shows only when `wanted` is ahead of `current`                                                                                                                      |
| `src/pipeline.ts`                      | changed           | Calls `ownDiscovery` or `discoverFromRegistry`; no `toManifestNames`                                                                                                                  |
| `src/managers/adapter.ts`              | changed           | `discover` removed; `ownDiscovery?` added; `Workspace.catalogs: Catalogs`                                                                                                             |
| `src/managers/{npm,pnpm,bun}/index.ts` | changed           | No `discover`. pnpm and bun read catalogs with the new readers. Parsers deleted in Phase 4                                                                                            |
| `src/managers/yarn/index.ts`           | changed           | `ownDiscovery` for berry; v1 parsers deleted in Phase 4                                                                                                                               |
| `src/managers/workspaces.ts`           | changed           | `workspaceOwner` deleted in Phase 4                                                                                                                                                   |
| `src/utils/manifestNames.ts`           | deleted (Phase 4) |                                                                                                                                                                                       |
| `src/types.ts`                         | changed           | `OutdatedEntry.name` doc. Phase 1 adds `RegistrySettings`                                                                                                                             |
| Phase 1                                |                   | `src/managers/pnpm/registries.ts`, `src/managers/bun/bunfig.ts`, the `registryConfig?` adapter hook, `src/project.ts`                                                                 |

Keep the new modules out of the `src/utils/index.ts` barrel and import them by path, as the pipeline already imports `@/utils/installed`. `src/discovery.ts` may import only types from `@/utils/registry`, which keeps `startup.test.ts` green.

### Adapter interface (`src/managers/adapter.ts`)

```ts
export type Catalogs = Record<string, Record<string, string>> // re-exported from dependencySpecs

export interface Workspace {
  isWorkspace: boolean
  /** Catalog entries by catalog name ('default' for `catalog:`), as the writers read them. */
  catalogs: Catalogs
  manifests: WorkspaceManifest[]
}

export interface ManagerAdapter {
  // … name, lockfile, readWorkspace, apply, installed?, saveStyle, overrides unchanged; `discover` removed
  /**
   * Yarn berry only, until #107: a project autd can't read natively yet is
   * discovered through the manager. Undefined means autd discovers natively.
   */
  ownDiscovery?(
    cwd: string,
  ): ((run: RunManager, workspace: Workspace) => Promise<Discovery>) | undefined
}
```

Yarn's implementation:

```ts
ownDiscovery: (cwd) =>
  isYarnBerry(cwd)
    ? (run, { isWorkspace }) => discoverBerry(run, isWorkspace)
    : undefined
```

The pnpm and bun applies change `catalogs.length === 0` to `Object.keys(catalogs).length === 0`.

### Pipeline (`src/pipeline.ts`, `discover`)

```ts
const own = adapter.ownDiscovery?.(cwd)
const discovery = own
  ? await own(runFor(adapter, cwd, 'discover'), workspace)
  : await discoverFromRegistry({
      cwd,
      manager: adapter.name,
      workspace,
      registry,
    })
const outdated =
  discovery.kind === 'single'
    ? discovery.outdated
    : foldWorkspaceEntries(discovery.entries)
```

Native discovery and berry both key rows by the manifest key already, so `toManifestNames` and `toEntryManifestNames` are no longer called. The "Detected catalogs" log uses `Object.keys(workspace.catalogs)`.

### Native discovery (`src/discovery.ts`)

```ts
export interface RegistryDiscoveryInput {
  cwd: string
  /** Names the install command in the "nothing installed" message. */
  manager: SupportedPackageManager
  workspace: Workspace
  registry: Pick<RegistrySession, 'lookup'>
  /** Installed copies by rowKey; default readInstalledPackages (node_modules). #107 adds lockfile readers here. */
  readInstalled?: (
    cwd: string,
    rows: { name: string; workspace?: string }[],
  ) => Record<string, InstalledPackage>
}
```

Steps:
1. **Read what each manifest declares.**
   - `declared = readDeclaredDependencies(cwd, workspace)`: the root first, then members by path; fields in `DISCOVERED_FIELDS` order.
   - A manifest that can't be read or parsed throws `StepError('discover', '<path>/package.json can't be read: …')`. It must never read as "nothing outdated".
2. **Stop when nothing is installed.** If `readInstalled` is not given, at least one dependency is declared, and `<cwd>/node_modules` is missing, throw:
   `StepError('discover', 'Nothing is installed in <cwd> (no node_modules): run `<pm> install`, then check again.')`
3. **Start the lookups.** Take the unique `name` values (an alias's target), sorted. Call `registry.lookup(name)` for each and keep the promises; requests start now.
4. **Read the installed copies.** `installed = readInstalled(cwd, rows)`, where each row is `{ name: key, workspace: isWorkspace ? path : undefined }`, read member-first, then the root.
5. **Wait for every lookup:** `await Promise.all(lookups)`. Lookups never reject, and the reader's limiter (`maxsockets`) bounds the network.
6. **Fail on any failed lookup** (D3): one `StepError('discover')` listing each `name: reason`. The reasons are already redacted.
7. **Build a row for each declared dependency:**
   - Skip it if `installed[key]?.linked`, or if it isn't installed and its key is a workspace member's name.
   - `current` is `installed.version`. If there is no installed copy, an optional dependency is skipped (debug) and any other gets `'missing'`.
   - `wanted` is `pkg.latest` for a `latest` spec, else `wantedVersion(range, pkg)`. If nothing satisfies the range, `wanted` falls back to `current`.
   - `latest` is `pkg.latest`.
   - Keep the row only if it is outdated (planning decision 7).
8. **Return the discovery.**
   - Single-package: `{ kind: 'single', outdated }`, with keys sorted. Each value is built as `{ name: key, current, wanted, latest }`, in that key order; bun's and yarn's snapshot bytes depend on it.
   - Workspace: `{ kind: 'workspace', entries }`, sorted by name and then `byPath`.
   - Also write the debug line from planning decision 14.

### The `wanted` rule (`src/utils/wanted.ts`)

```ts
export const wantedVersion = (
  range: string,
  pkg: RegistryPackage,
  { preferLatest = true } = {},
): string | undefined => {
  const pinned = semver.clean(range) // '1.2.3', '=1.2.3', 'v1.2.3': an exact pin is its own
  if (pinned) return pinned
  const satisfying = pkg.versions.filter((v) =>
    semver.satisfies(v.version, range),
  ) // ascending; semver's prerelease default
  if (satisfying.length === 0) return undefined
  if (preferLatest) {
    const latest = satisfying.find(
      (v) => v.version === pkg.latest && !v.deprecated,
    )
    if (latest) return latest.version
  }
  return (
    satisfying.findLast((v) => !v.deprecated) ??
    satisfying[satisfying.length - 1]
  ).version
}
```

`findLast` exists on the Node floor (`^22.23.0 || >=24.17.0`). If the `lib` setting rejects it, use a reverse loop.

### Spec classification (`src/utils/dependencySpecs.ts`)

`classifySpec(key, spec, catalogs)` applies these rules in order:
1. **`catalog:` or `catalog:<n>`.** `''` and `default` mean the `default` catalog. Take `catalogs[n]?.[key]` and classify that spec. A missing entry → `skipped` with a warning naming the manifest, the key and the reference.
2. **`workspace:`** → `skipped`.
3. **An alias,** matching `/^npm:((?:@[^/@]+\/)?[^@]+)@(.+)$/`: the same regex as `nextVersionSpec`. → `name` is the target and `range` the inner spec.
4. **Any `:`, `/` or `#`** (including `npm:x` with no range) → `skipped`.
5. **`latest`** → `{ tag: 'latest' }`.
6. **Not a valid range** (`semver.validRange(spec) === null`) → `skipped` with a warning ("autd follows only the `latest` dist-tag").
7. **Otherwise** a registry range. `''` is `*`.

```ts
export interface DeclaredDependency {
  workspace: string // '.' = root
  key: string // the manifest key (an alias's own name)
  name: string // what is looked up
  field: (typeof DISCOVERED_FIELDS)[number]
  spec: { range: string } | { tag: 'latest' }
}
```

### Catalog readers shared with the writers (`src/utils/files.ts`)

- **pnpm.** Extract `updatePNPMWorkspaceYAML`'s `rewriteLine` and its block / `catalogIndent` state into `mapPnpmCatalogEntries(text, visit: (catalog, name, spec) => string | undefined): string`. The `catalogs:` child-key regex needs a capture group for the catalog's name.
  - The writer becomes `mapPnpmCatalogEntries(text, (_, name, spec) => hasOwn(versions, name) ? nextVersionSpec(spec, versions[name], style) : undefined)`, with unchanged output; every existing `files.test.ts` case must pass untouched.
  - `readPnpmCatalogs(yaml)` collects the entries and returns `undefined` from `visit`. `catalogs: { default: … }` maps to `default`.
  - This is the pattern `pinWorkspaceYaml` already uses in the harness.
- **bun.** `readBunCatalogs(manifest)` reads top-level `catalog` and `catalogs`, keeping string values — exactly the fields `updateBunCatalogs` writes.
  - `workspaces.catalog(s)` is neither read nor written (the writer doesn't support it). This is a risk below.
- **`readWorkspace` uses these.** pnpm takes `readPnpmCatalogs(readWorkspaceYaml(cwd))`; bun takes `readBunCatalogs(readManifest(cwd))`; npm and yarn take `{}`. pnpm's and bun's old `catalogNames` are deleted in Phase 4.

### Installed versions (`src/utils/installed.ts`)

```ts
export interface InstalledPackage {
  version: string
  /** The entry is a symlink or junction to a directory inside the project and outside any node_modules: a workspace member or a link. */
  linked: boolean
}
export const readInstalledPackages = (cwd: string, rows: { name: string; workspace?: string }[]): Record<string, InstalledPackage>
export const readInstalledVersions = (cwd, rows) => /* map each to .version; behavior unchanged */
```

- **`linked` test.** The entry is a symbolic link (`lstat().isSymbolicLink()`; Node reports Windows junctions as symlinks), and `path.relative(realpath(cwd), realpath(entry))` stays inside the project with no `node_modules` segment.
- **The check is safe for every manager's layout:**
  - pnpm's `node_modules/<n>` → `.pnpm/…/node_modules/<n>` and bun's isolated `.bun/…` paths contain `node_modules`, so they aren't `linked`.
  - npm, yarn v1 and bun workspace links resolve to member directories, so they are.
- The declared-name filter is kept.

### Registry settings (Phase 1)

```ts
// src/managers/adapter.ts
/** The run's registry config for this manager: the .npmrc view, adjusted where the manager reads registries elsewhere. */
registryConfig?(cwd: string, fromNpmrc: RegistryConfig, sources: NpmrcSources): RegistryConfig

// src/project.ts, still lazy: called on the session's first registryConfig()
const adapter = adapterFor(detectPackageManager(cwd, pm))
registry: createRegistrySession(cwd, {
  depsDev: config.depsDev,
  loadConfig: (dir) => {
    const sources = processSources()
    const base = loadRegistryConfig(dir, sources)
    return adapter.registryConfig?.(dir, base, sources) ?? base
  },
})
```

The adapter returns the final config, so each manager encodes the precedence its real run showed.

- **pnpm** (`src/managers/pnpm/registries.ts`, pure, line-based like the other YAML readers):
  - top-level `registry:`;
  - `registries:` in either shape: legacy `default` / `"@scope"` → URL, or URL-keyed entries whose `scopes` is a flow or block list, where `"@"` means default;
  - entries with `ecosystem: pypi` or `cargo` are ignored, as are values containing `${`;
  - URL keys end at their last `:` before the end of the line;
  - quotes, comments and CRLF are handled.
- **bun** (`src/managers/bun/bunfig.ts`): a small TOML line reader shared with `bunfigExact`.
  - **`[install] registry`:** a string, an inline table `{ url, token }`, or a URL with userinfo.
  - **`[install.scopes]`:** `name = "url"` or an inline table `{ url, token }` / `{ url, username, password }`. A key may be written with or without `@`.
  - **Files read:** the global `$XDG_CONFIG_HOME/.bunfig.toml` when `XDG_CONFIG_HOME` is absolute, else `$HOME/.bunfig.toml`; then the project's `bunfig.toml`. The project file wins key by key.
  - **Env expansion:** `$NAME` / `${NAME}`. A credential with an unset variable is dropped, matching #105's rule; a URL with one is ignored, with a debug line.
  - **Env overrides:** `BUN_CONFIG_REGISTRY` / `NPM_CONFIG_REGISTRY` override the registry, and `BUN_CONFIG_TOKEN` / `NPM_CONFIG_TOKEN` supply its token.
  - **Credential mapping.** A token becomes `credentials['//host[:port]/path/'] = { authToken }`, through a new `nerfDart(url)` helper in `registryRequest.ts`. Userinfo is stripped from the stored URL and becomes `{ username, password: base64(decodeURIComponent(pass)) }`; `RegistryCredentials.password` is base64, as `.npmrc` stores it.

### Seams left for later issues

- **#107:** `readInstalled` on `discoverFromRegistry`, the no-`node_modules` check (which applies only to the default reader), `ownDiscovery` to delete, `readLockedVersions` kept, `wantedVersion({ preferLatest: false })`.
- **#108:** nothing needed in discovery. The cache sits behind `RegistrySession.lookup`, and `bench/targets.ts` `coldCaches` already says where its folder goes.
- **#47:** every `RegistryVersion` already carries `publishedAt`. Cooldown is untouched.

## Implementation Phases

### Phase 1 — Registry settings from pnpm-workspace.yaml and bunfig.toml (PR A; blocked by D2)

This phase is independent of the rest. It branches from `main` after #116 merges, as `feat/106-registry-settings`.

**Probe results, 2026-10-26 (step 1 is done; these supersede the design above where they differ).** Run on pnpm 12.14.0 (repo pin) and 12.15.0 (latest 12.x; all 43 cases identical) and bun 1.4.4, node 24.22.1, against two local servers with a sentinel proxy catching any fall-through to registry.npmjs.org. Scripts, per-case projects and request logs: `<scratchpad>/registry-probe/` (`run.cjs`, `cases-*.cjs`, `results.jsonl`, `requests.log`, `cases/<tool>/<id>/`). Cite "verified on pnpm 12.15.0 / bun 1.4.4, 2026-10-26" in code comments.

pnpm, per key (the default registry and each scope), highest source that sets it wins:
- Full order: `pnpm_config_*` env > project `pnpm-workspace.yaml` > global `config.yaml` > project `.npmrc` > global `auth.ini` > `~/.npmrc`. `npm_config_*` is not read at all.
- **In scope here:** the project `pnpm-workspace.yaml` over the `.npmrc` view. The env, `config.yaml` and `auth.ini` layers, and dropping `npm_config_*` for pnpm, are #117, not this phase.
- Within one yaml, top-level `registry:` beats a `registries` default.
- `registries` legacy map: `default: URL` sets the default and `"@scope": URL` sets a scope. A `"@"` key there is **ignored**.
- `registries` URL-keyed entries: `URL: { scopes: [...] }`, with flow or block lists. `"@"` in `scopes` **does** mean the default.
- A yaml value containing `${` is silently ignored, so pnpm falls through to the next source.
- Credentials always come from the `.npmrc` entry for the host the request lands on. The yaml never supplies them.
- The yaml didn't change any token in any case.

bun, per key, highest source that sets it wins:
- Full order: env (`BUN_CONFIG_REGISTRY` > `NPM_CONFIG_REGISTRY` / `npm_config_registry`) > project `bunfig.toml` > global bunfig > project `.npmrc` > user `.npmrc`.
- **Global bunfig is one file:** `$XDG_CONFIG_HOME/.bunfig.toml` when `XDG_CONFIG_HOME` is absolute, else `$HOME/.bunfig.toml`. `~/.config/.bunfig.toml` is not read when `XDG_CONFIG_HOME` is unset. Project and global merge key by key.
- **Env overrides:** a registry from `NPM_CONFIG_REGISTRY` / `BUN_CONFIG_REGISTRY` beats both bunfigs and `.npmrc`. With both set, `BUN_CONFIG_REGISTRY` wins.
- **`[install.scopes]`:** `acme = "URL"` and `"@acme" = "URL"` behave the same.
- **Credential order:**
  - A bunfig inline `token`, or userinfo in the URL (`http://user:pa%3Ass@host/` is Basic `user:pa:ss`, percent-decoded; `{ url, username, password }` is Basic) comes first.
  - Then `BUN_CONFIG_TOKEN` / `NPM_CONFIG_TOKEN`.
  - Then the `.npmrc` token for that host. A plain string URL in bunfig picks up the `.npmrc` token for its host.
- **Env expansion in bunfig:**
  - Only `$NAME`, and only in token values; scope tables count.
  - `${NAME}` is sent literally. Keep #105's rule that a credential still holding `${…}` is absent: sending the literal is useless.
  - An unset `$NAME` drops the credential, with bun's warning `registry token references unset variable $PROBE_TOKEN, ignoring credential`.
  - A `$` in a registry URL makes bun fail the install (`InvalidURL`), so autd ignores that URL with a debug line.
- **Out of scope here (#118):** bun reads `$XDG_CONFIG_HOME/.npmrc` _in place of_ `~/.npmrc` when it exists, and autd's loader layers npm's global npmrc, which bun doesn't read.

1. **Real-run precedence probe, done first.** Its results decide what the code encodes.
   - A scratchpad script, `<scratchpad>/registry-probe/serve.cjs`, starts two `node:http` servers on `127.0.0.1`, A and B.
   - They log `{ server, url, authorization }` as JSON lines and answer every request with 404 JSON.
   - Each case runs in a scratch project with `@acme/probe: 1.0.0` and `probe-unscoped: 1.0.0`, with `HOME` and `XDG_CONFIG_HOME` isolated.
   - **pnpm cases.** Run `pnpm install --lockfile-only` on the repo's pnpm 12.14.0 and on the latest 12.x (12.15.0 per deps.dev on 2026-10-21, via `corepack pnpm@<version>`).
     - Project `.npmrc` `@acme:registry=A` against `registries` legacy `"@acme": B`.
     - The same against URL-keyed `B: { scopes: ["@acme"] }`.
     - `.npmrc` `registry=A` against yaml `registry: B`.
     - `.npmrc` `registry=A` against `registries` with `"@": B`.
     - Yaml `registry: http://127.0.0.1:${PORT}/`: is it ignored?
   - **bun 1.4.4 cases.** Run `bun install` with `--lockfile-only` if 1.4.4 has it; otherwise a plain install, which fails on the 404 — the log is what matters.
     - `.npmrc` scope A against `[install.scopes] acme = "B"`.
     - `.npmrc` `registry=A` against `[install] registry = "B"`.
     - `NPM_CONFIG_REGISTRY=A` against bunfig B.
     - bunfig `{ url = B, token = "T1" }` against `.npmrc` `//127.0.0.1:B/:_authToken=T2`: which token arrives?
     - `token = "$PROBE_TOKEN"`: is it expanded?
   - Record each manager's version, the date and the outcomes in code comments ("verified on pnpm 12.x.y, 2026-10-…") and in the PR. If pnpm's precedence differs between 12.14.0 and the latest 12.x, encode the latest and say so.
2. **The type and the hook:** the `registryConfig?` adapter hook and `src/project.ts` as shown above. `openProject` still reads nothing until the session's first `registryConfig()`.
3. **The readers.** `src/managers/pnpm/registries.ts` exports `pnpmRegistrySettings(yaml)`, and the pnpm adapter's `registryConfig` applies the probe's precedence. `src/managers/bun/bunfig.ts` provides the TOML reader, `bunRegistrySettings(cwd, sources)` and `bunfigExact`, moved from `bun/index.ts`. `nerfDart(url)` goes in `src/utils/registryRequest.ts`.
4. **Tests,** on temp directories, never hand-written manager output:
   - `__tests__/managers/pnpmRegistries.test.ts`: both shapes, flow and block `scopes`, `"@"`, top-level `registry`, `${…}` ignored, `ecosystem` entries ignored, CRLF, quoted keys, comments.
   - `__tests__/managers/bunfig.test.ts`:
     - the value forms;
     - `$VAR` / `${VAR}`, and an unset variable dropping the credential;
     - global and local merging, and `XDG_CONFIG_HOME`;
     - environment overrides;
     - `bunfigExact` still works.
   - `__tests__/project.test.ts`: the hook isn't called by `openProject`; it is called once by the first `registryConfig()`.
   - `__tests__/utils/registry.test.ts`: against a local server, a scope routed only by bunfig gets its request with the bunfig token, and the cooldown's `releaseTimes` uses the same route.
5. **Docs.**
   - `CLAUDE.md`: replace "Yarn berry's `.yarnrc.yml` and Bun's `bunfig.toml` are not read in v1" with what is read now, and list what still isn't (pnpm global `config.yaml`, yarn `.yarnrc` / `.yarnrc.yml`).
   - `src/utils/CLAUDE.md`: the same change to its "Limitation" line, plus a note on the hook.
   - `src/managers/CLAUDE.md`: the adapter list.

**Gates:** the four standard gates. **Commit:** "Read registry routes from pnpm-workspace.yaml and bunfig.toml" (Refs #106).

### Phase 2 — Registry captures and the pure building blocks (PR B, no behavior change)

1. **Captures** in `__tests__/fixtures/registry/`, using #105's `cap` helper:

   ```sh
   D=__tests__/fixtures/registry; H=<scratchpad>/registry-headers; mkdir -p "$D" "$H"
   ABBREV='application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'
   cap() { curl -sS --compressed -H "Accept: $3" -D "$H/$1.headers" -o "$D/$1.body" \
             -w "$1 %{http_code} %{size_download}B %{content_type}\n" "$2"; }
   for n in yarn pnpm dayjs debug express semver zod axios lodash next qs react react-dom typescript; do
     cap "$n.dist-tags" "https://registry.npmjs.org/-/package/$n/dist-tags" application/json
     cap "$n.deps-dev"  "https://api.deps.dev/v3/systems/npm/packages/$n"  application/json
   done
   cap yarn.packument https://registry.npmjs.org/yarn "$ABBREV"
   cap pnpm.packument https://registry.npmjs.org/pnpm "$ABBREV"
   # bodies over 100 KB: gzip -9 -n <file>  (leaves <file>.gz, deterministic)
   ```

   `ms` is already captured. Add `*.gz binary` to `.gitattributes`.

   Checks before committing:
   - **yarn:** dist-tags `latest` is `1.22.22` and `berry` is `2.4.3` (seen 2026-10-26: `{"legacy":"1.21.1","rc":"1.22.0","berry":"2.4.3","latest":"1.22.22"}`). 2.4.3 is listed and isn't deprecated.
   - **pnpm:** 5.18.0–5.18.10 aren't deprecated, and 5.18.11 is ("In this version, a stackoverflow error happens with execa", seen on deps.dev 2026-10-26).
   - **dayjs:** 1.10.8 is the highest 1.10.x and isn't deprecated.
   - **The sources agree.** Per package, deps.dev and the abbreviated packument list the same versions and the same deprecated versions, and both include `latest`. The packuments for packages other than yarn and pnpm are fetched to the scratchpad and never committed. This is the Aikido guard.
   - **Size.** If pnpm's packument is over 1 MB gzipped, keep deps.dev only for pnpm and say so.
   - **README.** Add each file's status, content type, wire size, decoded size and date to the README, with the gzip note.
2. **Test helpers** in `__tests__/fixtures/index.ts`, all built on the real parsers from `@/utils/registryDocuments`:
   - `readRegistryBody(file)` gunzips a `.gz`.
   - `capturedPackage(name, { source = 'deps.dev', asOf? })` builds a `RegistryPackage` from `<file>.dist-tags` plus `<file>.deps-dev`, or from `<file>.packument`. File names follow `@types/ms` → `types-ms`.
     - `asOf` drops versions published after that instant.
     - Its `latest` is the captured `latest` if that survives, else the highest surviving stable version. It is a test-only approximation; say so in its doc comment.
   - `capturedRegistry(names, options)` is a `fakeRegistry` whose `lookup` answers from captures and throws for any other name.
   - `installPackages(cwd, dir, versions)` writes `node_modules/<name>/package.json` under `dir`.
   - Move the reader tests' `derive(file, edit)` here, so the wanted tests can derive variants. Variants are always derived from a capture, never typed.
3. **`src/utils/wanted.ts`** and `__tests__/utils/wanted.test.ts`, with every case run on `deps.dev` and on `packument`:
   - **yarn:**
     - `*`, `>=1.0.0` and `^1.0.0` give 1.22.22: `latest` is preferred over the higher 2.4.3;
     - `^2.0.0` gives 2.4.3, and the `2.0.0-rc.*` versions are excluded;
     - `*` with `preferLatest: false` gives 2.4.3;
     - the exact pin `1.22.19` gives itself;
     - `^99.0.0` gives `undefined`.
   - **pnpm:**
     - `~5.18.0` gives 5.18.10;
     - the exact pin `5.18.11` gives itself, even though it is deprecated;
     - `>=5.18.11 <5.18.12` gives 5.18.11: when every satisfying version is deprecated, the highest wins;
     - a derived variant marking `latest` deprecated makes `*` give the highest non-deprecated stable version below it;
     - a prerelease from the capture is excluded from `^<its major>` but included by a range naming its own prerelease tuple. Choose the versions from the fixture inside the test; never type one the fixture lacks.
4. **`src/utils/dependencySpecs.ts`**, with `__tests__/utils/dependencySpecs.test.ts`. `DEPENDENCY_FIELDS` moves here, and `manifestNames.ts` re-exports it until Phase 4.
   - **Classification table:** a range, an exact pin, an alias with a scoped target, `npm:x` with no range, `catalog:`, `catalog:tools`, `catalog:default`, an unknown catalog, `workspace:^`, git, `github:a/b`, `a/b`, `file:`, `link:`, an `https:` URL, `latest`, `next`, `''`.
   - **`readDeclaredDependencies` on temp directories:**
     - field order, and a duplicate key where the first field wins;
     - a peer-only key is excluded;
     - pnpm and bun catalogs;
     - members by path;
     - an unreadable member manifest is a `discover` `StepError`.
5. **The `files.ts` readers and the shared walk.** The existing writer tests stay unchanged; that is the proof the refactor kept the output.
   - Add `readPnpmCatalogs` and `readBunCatalogs` cases.
   - Add one agreement test: for a yaml with quoted keys, comments, CRLF and indented named catalogs, writing every entry `readPnpmCatalogs` returns, through `updatePNPMWorkspaceYAML`, changes exactly those lines.
6. **`readInstalledPackages`** in `__tests__/utils/installed.test.ts`:
   - a member linked from the root's `node_modules` with `fs.symlinkSync(..., 'junction')` is `linked`;
   - a pnpm-style store symlink is not;
   - `readInstalledVersions`' existing cases pass unchanged.

**Gates:** the four standard gates. **Commits:**
- "Capture registry documents for discovery's tests";
- "Add the wanted rule, the dependency spec reader and installed-link detection" (Refs #106).

### Phase 3 — One native discovery in the pipeline (PR B; blocked by D1 and D3)

1. **Evidence before the switch, on `main`'s build.** In a scratch project with a peer-only dependency installed below `latest`, run:
   - `npm outdated --json`
   - `pnpm outdated --json`
   - `yarn outdated --json` (yarn 1.22.22 through Corepack)
   - `bun outdated`
     Record which managers list it (planning decision 2).
2. **`src/discovery.ts`,** as specified.
3. **The adapter changes:**
   - change `adapter.ts`'s interface;
   - remove `discover` from npm, pnpm and bun;
   - yarn gets `ownDiscovery`, and its `discover` is removed;
   - pnpm and bun `readWorkspace` return catalog records;
   - the pnpm and bun applies use `Object.keys(catalogs).length`.
     The parsers stay exported for now, so their unit tests still run.
4. **`src/pipeline.ts`,** as shown in Technical Architecture.
5. **`src/utils/rows.ts`:** in `inRangeNote`, show the note only when `wanted` differs from `latest` and either `current` isn't a version (`missing`) or `semver.gt(wanted, current)`.
6. **Tests.** "Native" below means `capturedRegistry([...], { asOf })` plus `installPackages`, with `runProcess` answering only apply commands. Never type a version a capture doesn't hold. When a literal that is already in a test drifts, derive the registry with `asOf` the date that file's fixtures were captured, found with `git log --diff-filter=A --format=%aI -- <file>`. If `asOf` can't reproduce an existing expectation (for example, a version deprecated later), stop and report; don't edit the expectation.
   - **New `__tests__/discovery.test.ts`:**
     - for npm, pnpm, yarn v1 and bun, `check` never calls `runProcess`;
     - single-package and workspace records;
     - an alias is looked up as `dayjs` and keyed `dj`;
     - skipped specs are never looked up;
     - a linked member is skipped;
     - `missing` rows, and a missing optional dependency skipped;
     - no `node_modules` gives the `install` `StepError`;
     - two failed lookups give one `StepError` naming both, only after the other lookups settle;
     - one lookup per unique name;
     - the order;
     - a settings-only `pnpm-workspace.yaml` is discovered as `single`.
   - **The #95 regression test:**
     - a pnpm workspace with root `dayjs ~1.10.0` and `packages/m` (named) `^1.10.0`, both installed at 1.10.0;
     - expect `dayjs.workspaces` to equal `[{ path: '.', current: '1.10.0', wanted: '1.10.8' }, { path: 'packages/m', current: '1.10.0', wanted: <capture's latest> }]`;
     - assert the capture's `latest` isn't 1.10.8, which guards the fixture;
     - with `beyondRange: 'minor'`, `plan` gives `packages/m` an in-range target (`target === wanted`), so no spec would be rewritten.
   - **`__tests__/singlePackageJson.test.ts` (D1):**
     - native input, with `asOf` the `.snap` file's capture date;
     - `node_modules` holds dj 1.11.9, express 4.22.3, semver 7.6.3, zod 3.25.76, and ms at the `asOf` latest;
     - the `update` case's mocked `apply` writes each target into `node_modules`, so the post-apply check keeps `updated: true`;
     - assert that the four managers' JSON is equal;
     - the snapshot changes exactly as D1 lists, in its own commit: "Feed the single-package snapshot from registry captures".
   - **`__tests__/pipeline.test.ts`:** native, with every assertion kept. That covers the hoisted `ms` pin reported as not applied, which needs the `express` capture and `node_modules` written as now.
   - **`__tests__/managers/workspaceDiscovery.test.ts`:**
     - one `describe.each` over the four adapters;
     - `writeWorkspaceProject` plus installs of dayjs 1.11.9, ms 2.1.1 and debug 4.3.1 at the root, and ms 2.1.2 in `packages/a`;
     - `EXPECTED` and the printed-rows test kept;
     - the npm `--long` and bun `--filter *` argument tests dropped;
     - one case for an unnamed root kept.
   - **`__tests__/managers/withinRange.test.ts`:**
     - native over the 12 ranged packages, installed at `bench/ranges`' minimums, plus the `ms` pin, with `asOf` the observation date;
     - `NPM_UPDATE_APPLIES` unchanged;
     - "pinned" uses the 12 at their `bench/pinned` versions.
   - **`__tests__/managers/aliases.test.ts`:** native. The yarn branch goes away: all four move `dj` to 1.11.23 under `major`. Add an assertion that `lookup` was asked for `dayjs`, never `dj`.
   - **`__tests__/managers/stepFailures.test.ts`:** the discover case uses a lookup that fails with `{ ok: false, kind: 'request', reason: 'registry unreachable' }`, and expects a `discover` `StepError` containing that reason. The apply cases are unchanged.
   - **`__tests__/managers/reuseDiscovery.test.ts`:** rename the case to "applies without discovering again". The throwing `fakeRegistry` proves no lookup ran.
   - **`__tests__/managers/realSubprocess.test.ts`:** both cases move to apply.
     - The fake `npm update` prints 1.5 MB, and the update gets past it (M0's done-when).
     - The odd names go through `update(project, { discovered })`; the logged calls become `[['update', ...names]]`.
   - **`npm.test.ts`, `pnpm.test.ts`, `bun.test.ts`:**
     - delete the `check with <pm>` blocks;
     - pnpm's catalog `readWorkspace` cases expect records;
     - delete "discovers without -r", which the discovery test replaces.
   - **`yarn.test.ts`:**
     - delete `check with yarn v1`;
     - the update tests use `discovered` or native input;
     - the stderr-warning test moves to apply with `yarn/v1-upgrade.stderr`, if that capture contains `[DEP0169]`; otherwise keep `v1-outdated.stderr` for it and note why.
   - **`yarnBerry.test.ts`:** calls go through `yarn.ownDiscovery(cwd)`.
   - **`workspaceApply.test.ts` and `applyRanges.test.ts`:** `Workspace` literals use catalog records. Check that some apply test still asserts bun's `['update', …, '--filter', '*']`, and add one if not.
7. **Integration.** `__tests__/integration/harness.ts` gets `runCliWithoutManagers(cwd, args)`:
   - it points the PATH key (found case-insensitively, as `prependPath` does) at an empty scratch directory for the call, then restores it;
   - `runCli` already starts `process.execPath`.
     In `matrix.ts`, the first `check --json` uses it for every manager except `berry`. `expectations.ts` stays unchanged.

**Gates:** the four standard gates, plus `AUTD_INTEGRATION_PM=npm,pnpm,yarn,bun pnpm run test:integration`. **Commits:**
- "Discover from manifests, node_modules and the registry" (Refs #106);
- the D1 snapshot commit.

### Phase 4 — Delete the `outdated` parsers, their fixtures and dead helpers; docs (PR B)

1. **Code to delete:**
   - npm: `isOutdatedReport`, `parseNpmOutdated`, `parseNpmWorkspaceOutdated`. `readLockedVersions` stays.
   - pnpm: `isOutdatedReport`, `parsePnpmOutdated`, `pnpmEntries`, `parsePnpmWorkspaceOutdated`, `catalogNames`.
   - yarn: `isOutdatedReport`, `parseYarnOutdated`, `parseYarnWorkspaceOutdated`.
   - bun: `parseBunOutdated`, `catalogUser`, `parseBunWorkspaceOutdated`, `catalogNames`.
   - `workspaceOwner` from `workspaces.ts`.
   - `src/utils/manifestNames.ts`, with its imports pointed at `dependencySpecs.ts`.
   - `WORKSPACE_ENTRIES`, if nothing still uses it.
2. **Fixtures to delete:**
   - `npm/outdated*.stdout` and `outdated-error.stderr`. Keep `no-node-modules.package-lock.json`.
   - `pnpm/outdated*`. Keep `update-ignored-builds.*`.
   - `yarn/v1-outdated*`, except `v1-outdated.stderr` if Phase 3 kept it. Keep `berry-*`, `v1-update.*` and `v1-upgrade*`.
   - `bun/outdated*`. Remove the directory if it ends up empty.
3. **Tests to delete:** the parser blocks in the four adapter tests, `__tests__/utils/manifestNames.test.ts`, and the `workspaceOwner` cases in `workspaces.test.ts`.
4. **Sweeps:**
   - `rg -n "outdated" src __tests__ bench --glob '!**/fixtures/registry/**'` may show only berry's "berry has no `outdated`" comment and doc text.
   - `rg -n "toManifestNames|workspaceOwner|parse(Npm|Pnpm|Yarn|Bun)" src __tests__` must show nothing.
5. **Docs:**
   - **`CLAUDE.md`:**
     - the pipeline bullet: discovery is native, and berry discovers through `ownDiscovery` until #107;
     - the adapter bullet: no `discover` or parser; `ownDiscovery?` (and Phase 1's `registryConfig?`);
     - Workspace Detection: discovery reads every manifest, and the workspace flags are for apply only;
     - Configuration: `depsDev` now takes effect;
     - Testing Notes: manager fixtures are apply captures, and discovery tests use registry captures.
   - **`src/managers/CLAUDE.md`:**
     - remove the `outdated` success-check table, the parsers, the per-manager `outdated` column, "Discovery: names" and "Discovery: wanted";
     - add the native discovery section (spec rules, catalogs, installed and linked, failures, `wanted`);
     - drop the "declared manager with no lockfile … outdated fails" sentence, which the `install` message replaces.
   - **`src/utils/CLAUDE.md`:** the new modules and the `installed.ts` change.
   - **`src/commands/CLAUDE.md`:** a `discover` failure now means an unreadable manifest, nothing installed, or a failed registry lookup (berry: `yarn info`).
   - **`.claude/context/ai-context/docs-overview.md`:** sources, tests and fixtures.
   - **`README.md`:** sweep `rg -n "outdated|#106" README.md` and fix any description that says autd runs `<pm> outdated`.
6. **Badges.** Run `pnpm run test:badges` and commit `badges/` if coverage moved.

**Gates:** the four standard gates. **Commit:** "Delete the outdated parsers and their fixtures" (Refs #106).

### Phase 5 — Real-run gates, then the PR

1. **The full matrix:** `pnpm run test:integration`, all five managers including berry, on macOS. CI runs it per manager on ubuntu and windows.
2. **#95, on `main` and on the branch.**
   - Build `main` in a worktree: `git worktree add <scratchpad>/autd-main main`, then `pnpm install` and `pnpm run build` there.
   - A scratch script, run with `node -r ./bench/register.cjs <scratchpad>/issue-95.ts`, uses the harness's `copyProject` and `installAtMinimum('pnpm', 'issue-95', dir)` on the evidence workspace: root `dayjs ~1.10.0`, `packages/m` `^1.10.0`, pnpm 12.
   - Run `check --json` from each build. Expected:
     - `main`: both rows have `wanted: 1.10.8`;
     - the branch: root 1.10.8, `packages/m` at the registry's `latest`.
   - Then run `update --dry-run --json` with `{ "beyondRange": "minor" }` from each build. Expected:
     - `main`: plans a beyond-range rewrite of `^1.10.0`;
     - the branch: plans an in-range move.
   - Then run `update --json` on the branch. Whatever pnpm installs (it may dedupe `packages/m` onto 1.10.8), autd reports it truthfully. Record it.
3. **Bench, `main` against the branch,** on the same machine, back to back:

   ```sh
   AUTD_BENCH_PM=npm,pnpm,yarn,bun AUTD_BENCH_CLI=<scratchpad>/autd-main/dist/index.js pnpm run bench
   AUTD_BENCH_PM=npm,pnpm,yarn,bun pnpm run bench
   # and both again with AUTD_BENCH_PROJECT=ranges
   ```

   Pass on `bench/pinned`, for npm, pnpm, yarn and bun:
   - the branch's cold median is at or below `main`'s;
   - the branch's cold median is under 1.0 s, the M3 cold budget. Note the Aikido proxy. If it's over, try the reader's documented fallback (limiter at `2 × maxSockets`) once and report both;
   - the branch's peak memory is at or below `main`'s;
   - npm and yarn warm medians are at or below `main`'s;
   - pnpm and bun warm medians are reported, not gated (D6);
   - the startup row (`autd --version` against `node -e 0`) is within ±5 ms of `main`.

   On the branch, cold equals warm (autd has no cache yet), so say that the cold prepare only empties the managers' caches.

   For the lookup debug line (count, time, sources), use `AUTD_BENCH_KEEP=1` and run `node dist/index.js check` in a kept copy with `{ "debug": true }`.
4. **Behavior diff on real-world packages.**
   - On kept `bench/ranges` installs, one per manager, compare `check --json` from `main` and from the branch, projected to name, current, wanted and latest.
   - Explain every difference by a rule:
     - pass-through fields;
     - deprecated versions skipped (yarn v1 changes on purpose);
     - the `latest` preference;
     - the alias fix;
     - npm's `engines` filtering (M4).
   - A difference no rule explains is a bug: fix it before the PR.
5. **The PR,** through `/ship:pr`:
   - `Closes #106`, `Closes #95`;
   - What changed: before and after;
   - the regression tests: the #95 test and the no-subprocess test;
   - the Gates table, and the Real run (bench tables, #95 output, behavior diff);
   - user-visible changes for the changelog: D1's pass-through fields, the yarn alias rows, deprecated versions skipped on every manager, peer-only dependencies, failures listing packages, `check` no longer needing the manager on PATH, and `depsDev` now in effect;
   - Not verified: pnpm global `config.yaml` routes, yarn v1 `.yarnrc`, very large monorepos, berry (unchanged path).

## Design Considerations

- **Performance.**
  - Lookups start as soon as the manifests are read and run under the reader's limiter (`maxsockets`): two small requests per public package, deduped per run.
  - Reading `node_modules` and the `semver.satisfies` passes are negligible next to the network; next has about 3,500 versions per row.
  - There is no subprocess at all for the four managers. That removes npm's 347 MB and yarn's 756 MB peaks from `check`.
- **Startup.** `src/discovery.ts` imports only `fs`, `path`, `semver`, `StepError`, `logger` and the new pure utilities. The reader and the client still load on the first `lookup` (`startup.test.ts`).
- **Privacy.** With #106, `depsDev` takes effect: every name on a public registry goes to api.deps.dev unless `depsDev: false`, as #105 documented. Scoped and private registries never reach deps.dev.
- **Windows.**
  - Paths stay POSIX in `Workspace`, and `path.join` handles them.
  - Linked detection covers junctions; the tests use type `'junction'`.
  - The matrix's PATH change finds the key case-insensitively.
- **Code patterns to follow.**
  - Adapters stay plain objects. Failures are `StepError`s, never caught.
  - Debug and warn output goes through `logger`, so `--json` stays pure.
  - Tests use `fs.mkdtempSync` temp projects, `jest.mock('@/utils/logger')`, and `projectFor(adapter, cwd, config, registry)`.
  - Biome style: no semicolons, single quotes.

## Risks & Mitigation

1. **`wanted` differs from what a manager would choose.**
   - The differences: npm's `engines` filter (M4); npm takes a prerelease `latest` for `*`; yarn v1's deprecated-version quirk (dropped on purpose); pnpm's `--compatible`.
   - Mitigation: Phase 5's behavior diff explains every difference. The post-apply check reports what the manager actually installed.
2. **A registry autd doesn't know about.** The routes D2 leaves out, plus yarn v1's `.yarnrc`, mean a scoped name is sent to the wrong registry, 404s, and fails the run under D3.
   - Mitigation: the failure names the host autd asked. File the follow-up issues before the PR merges.
3. **A false `not-found` from a proxy.** A proxy that 404s `/-/package/<name>/dist-tags` makes #105's reader report `not-found`.
   - Mitigation: if a real run shows it, change the reader to confirm a dist-tags 404 with the packument (one extra request, only for names that are really missing).
4. **Installs without `node_modules`.** pnpm, bun and yarn users who run `check` without installing used to get lockfile versions; now they get the install error.
   - Mitigation: #107. Say so in the changelog.
5. **Capture drift and the Aikido proxy.**
   - Mitigation: the sources-agree check at capture time, `asOf` for expectations that already exist, and a stop-and-report rule instead of editing expectations.
6. **Large monorepos.** Requests scale with the number of unique dependencies divided by `maxsockets`.
   - Mitigation: #108's cache, and the limiter fallback.
7. **bun's `workspaces.catalog` / `workspaces.catalogs` form** is neither read nor written. A `catalog:` reference to it warns and is skipped.
   - Mitigation: a follow-up issue covering the reader and the writer together.
8. **Test churn.**
   - Mitigation: `fakeRegistry` fails loudly, Phase 4's sweeps, and Phase 2 landing before any behavior change.
9. **The warm regression on pnpm and bun.** Mitigation: D6.
10. **The snapshot change.** Mitigation: D1, an isolated commit, and the PR listing each changed entry.

---

Files this plan relies on (absolute paths):
- `/Users/tylerrobertson/personal_dev/always-up-to-date/src/pipeline.ts`
- `/Users/tylerrobertson/personal_dev/always-up-to-date/src/managers/adapter.ts`
- `/Users/tylerrobertson/personal_dev/always-up-to-date/src/managers/{npm,pnpm,bun,yarn}/index.ts`
- `/Users/tylerrobertson/personal_dev/always-up-to-date/src/managers/yarn/berry.ts`
- `/Users/tylerrobertson/personal_dev/always-up-to-date/src/utils/{files,installed,manifestNames,registry,registryReader,rows,npmrcLoader}.ts`
- `/Users/tylerrobertson/personal_dev/always-up-to-date/src/project.ts`
- `/Users/tylerrobertson/personal_dev/always-up-to-date/__tests__/singlePackageJson.test.ts`
- `/Users/tylerrobertson/personal_dev/always-up-to-date/__tests__/__snapshots__/singlePackageJson.test.ts.snap`
- `/Users/tylerrobertson/personal_dev/always-up-to-date/__tests__/integration/{harness,matrix,expectations}.ts`
- `/Users/tylerrobertson/personal_dev/always-up-to-date/__tests__/fixtures/index.ts`
- `/Users/tylerrobertson/personal_dev/always-up-to-date/__tests__/fixtures/registry/README.md`
- `/Users/tylerrobertson/personal_dev/always-up-to-date/docs/roadmap.md`
- `/Users/tylerrobertson/personal_dev/always-up-to-date/.claude/plans/registry-reader.md`
