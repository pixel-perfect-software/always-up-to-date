# Package Managers - Component Context

## Purpose

One adapter per package manager (npm, yarn, pnpm, bun): everything specific to that manager. The pipeline in `src/pipeline.ts` runs detect → discover → plan → apply → report the same way for every adapter.

## Current Status: Stable

All four package managers are implemented with workspace support. Yarn is one adapter for v1 and berry (2+), told apart by `isYarnBerry(cwd)`; berry has no `outdated`, so it still discovers from `yarn info` and the registry (`ownDiscovery`, until #107). npm, pnpm, yarn v1 and bun are discovered natively by `src/discovery.ts`, so no adapter runs or parses `outdated`.

## Component-Specific Development Guidelines

- An adapter is a plain object implementing `ManagerAdapter` (`adapter.ts`):
  - `name`, `lockfile`: what detection looks for
  - `projectRoot(dir)`: the directory this manager treats as the project for `dir` (the nearest package.json's directory): the workspace root that lists it, else `dir`. npm, yarn v1 and bun: the nearest ancestor whose `workspaces` lists it (`packageJsonWorkspaceRoot`); pnpm: the nearest `pnpm-workspace.yaml`'s directory when it is `dir` or its `packages` list `dir` (`pnpmWorkspaceRoot` in `workspaces.ts`, which `locate` shares; a member with its own yaml, or under a nearer yaml that does not list it, is its own project); berry: the nearest `yarn.lock` (`berryProjectRoot`), and a `detect` `StepError` for a directory that root's `workspaces` do not list, as berry refuses it. `openProject` calls it after detection; when it differs from `locate`'s workspace root, detection and the config are redone at the manager's root (#123)
  - `readWorkspace(cwd)` → `{ isWorkspace, catalogs, manifests, member? }`, read once per run and passed back to discovery and `apply`. `catalogs` holds the catalog contents, `Record<catalog, Record<name, spec>>` (`default` for `catalog:`), read by `readPnpmCatalogs` / `readBunCatalogs`. `manifests` is the root (`{ path: '.', name? }`) first, then each member directory the workspace patterns match, sorted by path
  - `ownDiscovery?(cwd)`: yarn berry only, until #107: returns `(run, workspace) => Discovery` when the project can't be read natively, else undefined. Every other project is discovered by `discoverFromRegistry` (`src/discovery.ts`; see "Native discovery" below). A `Discovery` is `{ kind: 'single', outdated: Record<string, PackageInfo> }` in a single-package project, `{ kind: 'workspace', entries: OutdatedEntry[] }` (one entry per package per owning manifest) in a workspace, keyed by the manifest key
  - `apply(run, cwd, plan, workspace)`: writes the specs the manager does not write itself, then runs its update commands. `plan` is `{ names, withinRange, beyondRange, manifests }`; the first three are unions across manifests, `manifests` is the same split per manifest (`ManifestPlan[]`, root first), which a workspace apply reads
  - `installed?(run, cwd, rows)`: optional. The versions installed after apply, keyed by `rowKey`, for a manager whose installs can't be read from node_modules. The pipeline uses it instead of `readInstalledVersions` when present; yarn implements it (berry: `yarn info -A --json`, since PnP has no node_modules; v1: the node_modules reader)
  - `npmrcLayers?(cwd, sources)`: optional. The `.npmrc` layers this manager reads, highest first (`NpmrcLayer[]`); npm's when absent. pnpm (`pnpm/npmrc.ts`), bun (`bun/npmrc.ts`) and yarn v1 (`yarn/npmrc.ts`) build their own. From a workspace member, pnpm and bun read the workspace root's settings files, not the member's; yarn v1 reads the member's, `~/.npmrc`, then the parents' (the root's included)
  - `emptyRegistry?`: whether an empty `registry` / scope route fails the manager's run (npm's `{ registry: true, scopes: false }` by default; pnpm both, yarn and bun neither); an unusable value is recorded in `RegistryConfig.unusable` and fails discovery (`src/utils/CLAUDE.md`)
  - `registryConfig?(cwd, fromNpmrc, sources, npmrc)`: optional. The run's `RegistryConfig` for this manager, adjusting the merged `.npmrc` view (`npmrc`) where the manager reads registries elsewhere: yarn v1 (`yarn/yarnrc.ts`, .yarnrc, over `yarn/npmrc.ts`'s own `.npmrc` layers; berry keeps the `.npmrc` view) and bun (`bun/bunfig.ts`, bunfig.toml and the registry/token variables). Precedence in `src/utils/CLAUDE.md`
  - `saveStyle(cwd)`: exact or prefix for specs that can't keep their shape, read from where the manager's current version keeps it
  - `pinning(cwd)`: what `applyPinned` needs for a cooldown fallback (#147): `install` (the install after a manifest write), `writeCatalog?` (pnpm, bun) and `relock?` (both yarns)
  - `overrides(cwd)`: packages pinned by an override field the manager enforces
- Adapters never log progress, group output, run the policy or catch failures: the pipeline does. `run` is bound to the step, so a failure is already a `StepError`
- Adding a manager: its adapter directory, its entry in `adapters` (`index.ts`) and `SupportedPackageManager`, and fixtures in `__tests__/fixtures/<pm>/`. Nothing else changes

## Major Subsystem Organization

```
managers/
  adapter.ts           # ManagerAdapter, Workspace, WorkspaceManifest, Discovery, RunManager, ApplyPlan
  index.ts             # adapters registry (detection order), adapterFor(name)
  workspaces.ts        # readManifest(), packageJsonWorkspace() (npm/yarn/bun), workspacePatterns(), readWorkspaceManifests() (the member map), ownerPath() (berry); nearestManifestDir(), listsMember(), packageJsonWorkspaceRoot(), memberAt(), pnpmWorkspacePatterns(), pnpmProjectRoot(), pnpmWorkspaceRoot() (member runs, #123)
  npm/index.ts         # npm adapter, readLockedVersions (kept for #107)
  yarn/index.ts        # yarn adapter (v1 `upgrade`, berry's ownDiscovery), isYarnBerry
  yarn/npmrc.ts        # yarnNpmrcLayers(), YARN_NPM_ENV: yarn v1's .npmrc layers (cwd, user, prefix, parents)
  yarn/yarnrc.ts       # parseYarnrc(), yarnrcRoutes(), yarnRegistryConfig(): registry routes from yarn v1's .yarnrc
  yarn/berry.ts        # berry: parseBerryInfo, parseBerryRegistry, discoverBerry, applyBerry, installedBerry
  yarn/lockfile.ts     # rewriteYarnV1Lock, rewriteBerryLock: record a range against a version locked under another spec (pin relock, integration harness)
  pin.ts               # applyPinned(): cooldown fallbacks, pinned and restored before apply (#147)
  pnpm/index.ts        # pnpm adapter
  pnpm/npmrc.ts        # pnpmNpmrcLayers(), PNPM_ENV, pnpmConfigDir(): pnpm 12's .npmrc layers
  pnpm/registries.ts   # pnpmRegistrySettings(yaml, { env }?), substitutePnpm(): registry routes from a pnpm yaml file (the parser only)
  bun/index.ts         # bun adapter
  bun/npmrc.ts         # bunNpmrcLayers(), bunUserNpmrc(), substituteBun(): bun's .npmrc layers (project, one user file)
  bun/bunfig.ts        # bunfigExact(), parseBunfigRegistries(), bunRegistryConfig(): registry routes and credentials from bunfig.toml
```

## Architectural Patterns

### Running commands (`src/commandRunner.ts`)

- `runCommand(packageManager, args, cwd, isSuccess?)` runs the manager with an argument array via `runProcess` and returns stdout. Build `args` as an array (`['update', ...names]`); shell quoting such as `'*'` must not appear in arguments
- Success is decided by a `SuccessCheck` over `{ exitCode, stdout }`; the default is exit 0. stderr is never a failure signal (yarn v1 on Node 24 always prints a DEP0169 warning); it is logged with `logger.debug`
- A failure throws `Command execution failed: <stderr, else stdout>`; a process with no numeric exit code (spawn failure, killed) throws the "unknown error" message. `runCommand` does not log failures; the command layer reports them once
- The pipeline hands each adapter `run(args, { isSuccess?, manifestWritten? })`, which is `runStep` bound to the step (`discover` or `apply`) and the manager: a failure rethrows as a `StepError`. Pass `manifestWritten: true` when autd rewrote a manifest before the apply command (npm, pnpm, bun); yarn writes its own manifest, so it passes `false`. Nothing catches: failures reach `src/commands/reportFailure.ts`
  Every command uses the default success check (exit 0); there is no `outdated` to treat specially.

### Package Detection (`src/detectPackageManager.ts`)

`detectPackageManager(root, pm?, { from, cwd }?)`, first source that answers (`root` is the workspace root that lists the run's directory, `locate()` in `src/projectLocation.ts`; `from` the member's directory, whose declaration is the nearest package.json's between it and `root`; lockfiles are always `root`'s; messages name declaring files relative to `cwd`, the command's directory, and the searched directory when it is not `cwd`):
1. `pm`: the `--pm` option
2. package.json `packageManager` (`pnpm@12.14.0+sha512.…`): the name before the first `@`
3. package.json `devEngines.packageManager`: one `{ name }` or an array of them. Of the supported names, the one with a lockfile present, else the first
4. The lockfiles: each adapter's `lockfile`, in registry order npm -> yarn -> pnpm -> bun, last match wins. With more than one, a warning names the choice

A `packageManager` naming an unsupported manager falls through to `devEngines.packageManager`; when every declaration names only unsupported managers (`deno@2.5.0`), the `detect` step fails rather than guessing from a lockfile. Lockfiles that disagree with the chosen manager are logged at debug level as ignored, unless the declared manager has no lockfile while another has, which warns. A `--pm` that contradicts a declaration warns (Corepack may refuse it). The choice itself is logged at debug level. With nothing declared and no lockfile, `detect` fails and suggests `--pm`. A declared manager with no lockfile is used.

### Workspace Detection

| Manager             | Method                                                                                                                |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| npm                 | `package.json` `workspaces` field (array or `{packages: [...]}`)                                                      |
| yarn (v1 and berry) | `package.json` `workspaces` field                                                                                     |
| pnpm                | `pnpm-workspace.yaml` with a non-empty `packages:` list (a file holding only settings or catalogs is not a workspace) |
| bun                 | `package.json` `workspaces` field, plus optional `catalog` / `catalogs` (top level or under `workspaces`)             |

Discovery needs no manager flags: it reads each manifest in `Workspace.manifests`. The flags (`-r`, `--filter *`) belong to apply. Berry's discovery reads `yarn info -A --json`, one entry per workspace valued `<name>@workspace:<path>`.

The member map (`readWorkspaceManifests`) expands the patterns with `readdirSync`, not `fs.globSync`: literal directories, `{a,b}` braces, `*`, `?` and `[…]` / `[!…]` classes within a segment, `**` as a whole segment, and `!` negations applied after the positive patterns. It skips `node_modules`, dot-directories (unless the pattern segment starts with `.`) and symlinks, counts only directories with a package.json, and matches nothing for extglobs such as `@(a|b)` (logged at debug level). `listsMember` and `matchesWorkspacePatterns` apply the same `node_modules` and dot-directory skips to a path, so `packages/a/node_modules/lodash` is not a member of `packages/**`; they do not test for symlinks, which a cwd (a real path) never is. Berry's owner paths go through `ownerPath`, which fails `discover` for one outside the root (`..`, absolute), since apply writes the owner's package.json.

`catalogs` holds the catalog contents, `Record<catalog, Record<name, spec>>` with `default` for `catalog:` (pnpm: `readPnpmCatalogs` over pnpm-workspace.yaml, the walk its writer uses; bun: `readBunCatalogs` over `catalog` and `catalogs` of package.json, from `workspaces` when set there, else the top level, as bun reads them; npm and yarn: `{}`). The pipeline logs the workspace once per run, and the catalog names when it is a workspace.

## Integration Points

- `src/pipeline.ts`: `check(project)`, `plan(project, outdated, targets?)`, `update(project, { targetPackages?, discovered? })`, where a `Project` is `{ root, member?, config, adapter, registry }`. `openProject(cwd, { pm? })` (`src/project.ts`) builds it: `locate(cwd)`, the config (the member's file, else the root's), `adapterFor(detectPackageManager(workspaceRoot, pm, { from }))`, then `adapter.projectRoot(dir)` for `root` (when that is not the workspace root `locate` found, detection runs again there and the config is reloaded with it as the fallback; a different manager is a `detect` `StepError`); `member` (`memberAt`) is set when `root` is not the directory. Everything the pipeline runs or writes uses `root`. `Workspace.member` (set by `workspaceOf(project)`) scopes discovery to that manifest, for `check` and `update --dry-run`; berry's `discoverBerry` keeps only that member's `yarn info` workspace. `update` from a member is refused by `refuseMemberApply(project)` before `discover`, and `-i` before the checklist: every manager's install rewrites the lockfile all workspaces share and moves other workspaces' locked copies (npm's also leaves `node_modules` behind `package-lock.json`; yarn v1's `workspace … upgrade` unlinks the member's other dependencies; berry's `up` is project-wide), so a write is never scoped to a member
- `plan` runs `src/utils/filterPackages.ts` with `project.config` and `adapter.overrides(root)`
- `src/utils/files.ts` `updatePackageJson(dir, …)` writes version updates before running the manager's update command (npm, pnpm, bun), only for packages moving past their range, once per owning manifest (`ManifestPlan.beyondRange`). `splitCatalogUpdates()` routes a workspace's beyond-range rows: an owning spec of `catalog:` / `catalog:<name>` (read with `readSpec()`) writes that catalog's entry (`catalogs`: catalog → name → version, written one catalog at a time), every other row its own manifest. A single-package pnpm project with catalogs routes the same way
- `src/utils/overrides.ts` (`overridesFromField`, `manifestOverrides`) and `src/utils/saveStyle.ts` (`readTextFile`, `yamlValue`) hold the generic readers adapters build on

### Native discovery (`src/discovery.ts`, npm, pnpm, yarn v1, bun)

No subprocess: `check`, and `update`'s discovery, read the manifests, `node_modules` and `RegistrySession.lookup`. The same rules for every manager:
- **Declared:** `dependencies`, `devDependencies`, `optionalDependencies` of the root and each member (`readDeclaredDependencies`). A name only in `peerDependencies` is not discovered (npm and bun's `outdated` listed it; pnpm's and yarn v1's did not). A manifest that can't be read is a `discover` `StepError`
- **Specs:** `classifySpec` resolves `catalog:` through `Workspace.catalogs`; skips `workspace:`, git, file, link, URL and github specs (debug line); looks an `npm:name@range` alias up by its target and keys the row by the manifest key, and a bare `npm:name` as the `latest` of that name (npm reads it so); follows `latest`; warns and skips any other dist-tag and an unknown catalog entry
- **Installed:** `readInstalledPackages` reads `node_modules`. A symlink or junction to a directory inside the project (a link) is skipped without a lookup, and so is any dependency named like a workspace member, whatever is installed (pnpm's injected workspace packages are real copies; an `npm:` alias to a registry package of that name is still looked up). A dependency not installed is a `current: 'missing'` row; a missing optional one is skipped. With a registry dependency declared and no `node_modules` in the root or in any manifest that declares one (pnpm with `sharedWorkspaceLockfile: false` installs per member), discovery fails telling the user to run `<pm> install`; `requireNodeModules: false` (for a lockfile reader, #107) turns the check off
- **`wanted`** (`wantedVersion`), per manifest: an exact pin is its own; else `latest` if it satisfies the range and isn't deprecated; else the highest non-deprecated satisfying version; else the highest satisfying one. It can sit below `current` (a deprecated version installed); `rows.ts` then shows no in-range note. Nothing satisfying: `wanted` is `current` (and no note)
- **Listed** when `current` is `missing`, or `latest` or `wanted` is ahead of `current`. Sorted by name (workspace: then root first, then path)
- **Failures:** every lookup settles, then any `ok: false` becomes one `StepError('discover')` naming each package with its reason (the first 10, then "and N more"). Nothing is left out silently
- A workspace is folded by `foldWorkspaceEntries()` into one `PackageInfo` per name carrying `workspaces`

### Apply: within range vs beyond range

- In-range updates (`target == wanted`) go to the manager by name with no manifest write: `npm update`, `pnpm update`, `bun update`, yarn `upgrade name@<current spec>`. Each manager installs `wanted`; npm and yarn leave package.json alone, pnpm and bun raise the range floor (their own convention)
- Beyond-range updates get their spec rewritten to the target first (decorator kept), then the same command
- npm: writes each manifest in `plan.manifests` that has beyond-range rows, then one `npm update <names>` at the root. No `--workspaces`: that would skip the root's own dependencies, while a root `npm update` moves every workspace's ranges (verified on npm 11.19.1, including a member spec autd just rewrote, so no `install` is needed between)
- pnpm: a workspace writes catalog rows to pnpm-workspace.yaml and the rest to their own package.json, runs `install --no-frozen-lockfile` if anything was written, then `update -r <in-range names>`. A single-package project with catalogs keeps its own branch (both rewrites, `install --no-frozen-lockfile`, `update <names>`). `--no-frozen-lockfile` because with `CI` set pnpm makes a plain `install` frozen and refuses the lockfile the rewrite made stale (#98); bun and yarn v1 don't freeze under `CI`
- bun: a workspace without catalogs writes each manifest, then `update <names> --filter *`. With catalogs it writes catalog entries (`updateBunCatalogs`) and the rest per manifest, runs `install` if anything was written, then `update <in-range names> --filter *`. A single-package project always takes the plain path
- A manager may leave a row where it was (npm dedupes a member's `dayjs` onto the root's pin, pnpm keeps root `ms` at its lockfile version); the post-apply check reads each row's installed version member-first and reports `not applied by <pm> (installed …)`

### Cooldown fallbacks (`src/managers/pin.ts`, #147)

A fallback moves below the version the manager picks when asked by name, so `applyPinned` runs before `apply` (which then gets `names` without those packages, and is skipped when nothing else moves): write the exact version into each row's manifest or catalog (`SaveStyle.pin`), `pinning.install`, put every touched file back byte for byte, write past-the-range rows to the version as a beyond-range row is written, `relock` if the adapter has one, then `install` again. npm 11.19.1, pnpm 12.14.0 and bun 1.4.4 keep the locked version when the range comes back; yarn 1.22.22 and 4.12.0 key `yarn.lock` by spec and resolve the restored range again to the newest, so the yarn adapter relocks with `rewriteYarnV1Lock` / `rewriteBerryLock` (`yarn/lockfile.ts`, shared with the integration harness). Verified end to end on all five, 2026-10-27, with each frozen install passing after, and with a gapped range (`^0.7.1 || ^2.1.3`) on 2026-10-29 (#151). `rewriteYarnV1Lock` quotes a key as yarn 1.22.22 does (`shouldWrapKey`): a bare key holding a space, such as `ms@^0.7.1 || ^2.1.3`, reads back as another pattern, and yarn resolves the range again. Both rewriters find an `npm:` alias under its target, as yarn 1.22.22 and 4.12.0 lock it (`m@npm:ms@2.1.2`, and in berry's workspace entry `m: "npm:ms@2.1.2"`), and record the alias's restored spec against it; verified on all five with `"m": "npm:ms@^2.0.0"`, 2026-10-29 (#152). The restored range is the one written, so pnpm and bun don't raise its floor as their `update` would

### Yarn apply (`src/managers/yarn/index.ts`)

- yarn writes the manifest itself: autd passes `name@spec` descriptors from `buildUpdateDescriptors()` and never pre-writes `package.json` (v1 then fails with "Outdated lockfile")
- v1 runs `yarn upgrade <descriptors>`; it has no `update`. In a v1 workspace `upgrade` at the root only touches the root manifest, so each manifest in `plan.manifests` gets its own command: `upgrade` for the root, `workspace <name> upgrade` for a member (the name comes from `Workspace.manifests`; a member without one is an `apply` StepError), one command per manifest carrying every field's descriptors. `-D` and `-O` are not `upgrade` options in yarn 1.22.22 (commander takes the next descriptor as their value and upgrades everything), and without a field flag a member's `upgrade` copies a devDependency into `dependencies`. So after each member command autd writes the manifest's original bytes back, then its beyond-range specs through `updatePackageJson` (the same `nextVersionSpec` the descriptors carried), and runs one `install --check-files` if a member command ran (a member upgrade leaves the member's other dependencies out of node_modules and yarn thinks it up to date, so `--check-files`). The root's `upgrade` copies nothing (p1-rootdev), so the root keeps yarn's own write of its manifest and needs no install. `manifestWritten` is true for the commands after autd's own write. No `--recursive`: v1 ignores it
- `isYarnBerry(dir)` (exported here; also decides save style and overrides): from `dir` up to the yarn project's directory (`yarnProjectDir`: the nearest `yarn.lock`, else the nearest ancestor listing `dir`), the nearest `packageManager: yarn@N` decides (2+ is berry); otherwise a `.yarnrc.yml` in that walk means berry. A member without its own `packageManager` is so judged by its root's
- Packages a manifest does not list are skipped with a warning naming it: v1 `upgrade` at a workspace root adds them as root dependencies

### Yarn berry (`src/managers/yarn/berry.ts`)

Berry has no `outdated` (`yarn outdated` runs a script of that name), so v1's path is not used when `isYarnBerry(cwd)`. Verified on yarn 4.12.0 with PnP and with `nodeLinker: node-modules`.
- Discovery: `yarn info -A --json` (NDJSON; `-A` is needed or a workspace project's root entry is missing). Each workspace is an entry whose value is `<name>@workspace:<path>`, with `children.Dependencies: [{ descriptor, locator }]`. The descriptor gives the manifest key and range, the locator the locked version. `parseBerryInfo` reads only workspace entries. Peer-dependent packages are virtual (`debug@virtual:<hash>#npm:~4.3.1`): the `virtual:<hash>#` part is stripped. A builtin-patched package (typescript, fsevents, resolve) is `typescript@patch:typescript@npm%3A^5.4.0#optional!builtin<compat/typescript>`: the URL-decoded npm range between `patch:<name>@` and `#` is used (a `patch:` without `builtin<` is left out). An alias `dj@npm:dayjs@^1.11.9` queries `dayjs` and keeps `dj` as the row name. `workspace:`, `portal:`, `link:`, `file:`, git and URL descriptors are left out
- Then `yarn npm info <names…> --fields dist-tags,versions --json`, 50 names per call, through the registries and auth in `.yarnrc.yml` (one JSON line per package). One unknown package fails the whole call, which fails `discover` with yarn's message. `wanted` is `semver.maxSatisfying(versions, range)` (prereleases excluded unless the range names one), never below `current`; `latest` is `dist-tags.latest`; `current` is the locked version. A row is outdated when `latest` or `wanted` is newer than `current`. A dependency whose range or lock is not semver is left out
- A single-package project returns `{ kind: 'single' }` from the root workspace; a workspace project returns `{ kind: 'workspace' }` entries sorted by name, then root first, with the owner from the `@workspace:` path (`ownerPath` rejects one outside the root)
- Apply (`applyBerry`): each manifest in `plan.manifests` with beyond-range rows is written by `updatePackageJson` (the save style comes from `.yarnrc.yml`), then `yarn install --no-immutable` if anything was written (`--no-immutable`: on CI yarn refuses an install that changes `yarn.lock`), then `yarn up -R <withinRange…>` if any. `up -R` re-resolves those packages to the highest version their existing ranges allow, project-wide, and leaves package.json alone. `yarn up name@range` would set that range in every workspace using the package, so it is not used. The project-wide in-range command is what `holdTogether` already assumes. `up -R` also re-resolves transitive copies of those packages within their own ranges, which the plan doesn't list. Locator references may carry `::key=value` parameters (`::__archiveUrl=…` from registries with nonstandard tarball URLs, `::version=…` on patches); `npmSpec` drops them before reading the version
- Post-apply check: `installed` re-runs `yarn info -A --json` and reads the locked version of each row from its own workspace
- Not covered: yarn `catalog:` specs (the spec is not rewritten, so a beyond-range move is reported `not applied`); `.yarnrc.yml` registry config for the cooldown (see `src/utils/CLAUDE.md`); peer-conflict holds under PnP (`peers.ts` reads node_modules)

### Integration matrix (`__tests__/integration/`, `testRepos/`)

`pnpm run test:integration` runs the built CLI against every manager on temp copies of `testRepos/<manager>-<layout>`: each range installed at its minimum, ranges restored, the lockfile rewritten to agree. It asserts autd's own output (never the manager's) against values derived from the ranges. Manager behavior it has observed and asserts, as per-manager overrides in `expectations.ts`:
- pnpm, in a workspace or with catalogs, dedupes the root's `ms` (`~2.1.1`) onto 2.1.2, which a member pins: `pnpm update -r ms` writes `~2.1.2`, and autd reports the row `not applied by pnpm (installed 2.1.2)`
- pnpm and bun raise range floors on `update`; npm, yarn v1 and berry leave package.json alone (see the apply notes above)
- bun 1.4.0 raises floors in package.json but leaves `catalog`/`catalogs` ranges as written; pnpm 12 raises its catalog ranges too
- It found two autd bugs, fixed in #59's branch: yarn v1 member devDependencies duplicated into `dependencies` (the `-D` fix there was wrong, yarn 1.22.22's `upgrade` has no `-D`; autd now restores and writes the manifest itself, see the yarn apply notes above), and bun catalog rows (`catalog (<ws>)`) failing discovery
- `runMemberMatrix` runs every workspace layout from `packages/a`, `packages/a/src` and `packages/b`: `check --json` and `update --dry-run --json` are the member's slice of the root's expectations (`expectedMemberCheck`, `expectedMemberPlan`) and leave every manifest and lockfile byte-identical; berry's `--pm yarn` matches the run without it; `update --json` exits 1 with the `apply` refusal naming the root, with no manager on PATH (so nothing ran) and every file unchanged (`snapshotFiles`). After the root `update --json`, `frozenInstall` (`npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `yarn install --immutable`, `bun install --frozen-lockfile`) proves the lockfile still agrees with the manifests
