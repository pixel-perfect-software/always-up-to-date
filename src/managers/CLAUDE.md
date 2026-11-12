# Package Managers - Component Context

## Purpose

One adapter per package manager (npm, yarn, pnpm, bun): everything specific to that manager. The pipeline in `src/pipeline.ts` runs detect → discover → plan → apply → report the same way for every adapter (`.claude/context/ai-context/pipeline.md`). Every manager, berry included (#107: `yarn.lock` and `.yarnrc.yml`), is discovered natively by `src/discovery.ts`, so no adapter runs a manager command or parses `outdated` for `check`.

Each manager's own detail (settings files and precedence, credentials, release-age gate, apply, verified versions and probes) is in its Tier 3 doc, which loads when you touch its directory: `npm/CLAUDE.md`, `pnpm/CLAUDE.md`, `yarn/CLAUDE.md` (v1 and berry), `bun/CLAUDE.md`.

## The adapter (`adapter.ts`)

An adapter is a plain object implementing `ManagerAdapter`, holding only what is specific to it:

- `name`, `lockfile`: what detection looks for
- `projectRoot(dir)`: the directory this manager treats as the project for `dir` (the nearest package.json's directory): the workspace root that lists it, else `dir`. npm, yarn v1 and bun: the nearest ancestor whose `workspaces` lists it (`packageJsonWorkspaceRoot`); pnpm and berry have their own rule (Tier 3). `openProject` calls it after detection; when it differs from `locate`'s workspace root, detection and the config are redone at the manager's root (#123)
- `readWorkspace(cwd)` → `{ isWorkspace, catalogs, manifests }`, read once per run and passed back to discovery and `apply`; `Workspace.member` is never set here, the pipeline adds it for a member run. `catalogs` holds the catalog contents, `Record<catalog, Record<name, spec>>` (`default` for `catalog:`), read by `readPnpmCatalogs` / `readBunCatalogs` (npm and yarn: `{}`). `manifests` is the root (`{ path: '.', name? }`) first, then each member directory the workspace patterns match, sorted by path. The pipeline logs the workspace once per run, and the catalog names when it is a workspace
- `apply(run, cwd, plan, workspace)`: writes the specs the manager does not write itself, then runs its update commands. `plan` is `{ names, withinRange, beyondRange, manifests }`; the first three are unions across manifests, `manifests` is the same split per manifest (`ManifestPlan[]`, root first), which a workspace apply reads
- `saveStyle(cwd)`: exact or prefix for specs that can't keep their shape, read from where the manager's current version keeps it (`src/utils/MANIFESTS.md`)
- `pinning(cwd)`: what `applyPinned` needs for a cooldown fallback (#147): `install` (the install after a manifest write), `writeCatalog?` (pnpm, bun) and `relock?` (both yarns)
- `overrides(cwd)`: packages pinned by an override field the manager enforces
- Optional:
  - `installed?(run, cwd, rows)`: the versions installed after apply, keyed by `rowKey`, for a manager whose installs can't be read from node_modules; the pipeline uses it instead of `readInstalledVersions`. yarn implements it (berry: `yarn.lock`; v1: the node_modules reader)
  - `installedFromLockfile?(cwd)`: `{ file, read }` (a `LockedInstall`, optionally with `peers`, #232) when installed versions must come from the lockfile because node_modules can't say: npm's `package-lock.json` without `node_modules`, berry's `yarn.lock` always (#107)
  - `installedGraph?(cwd)`: the install's `InstalledGraph` from its lockfile, for the peer pass (`<pm>/graph.ts`; pnpm's in `src/utils/installedGraph.ts`); undefined without one
  - `prefersLatestInRange?(cwd)`: default true. Whether a range resolves to `latest` when `latest` satisfies it (`wantedVersion`'s `preferLatest`); yarn berry returns false (#107: 4.18.1 resolves to the highest)
  - `npmrcLayers?(cwd, sources)`: the `.npmrc` layers this manager reads, highest first (`NpmrcLayer[]`); npm's when absent. pnpm, bun and yarn v1 build their own; berry's are empty. From a workspace member, pnpm and bun read the workspace root's settings files, not the member's; autd loads every manager's view at the project root, where it runs the manager (#127)
  - `registryConfig?(cwd, fromNpmrc, sources, npmrc)`: the run's `RegistryConfig`, adjusting the merged `.npmrc` view where the manager reads registries elsewhere: yarn v1 (`.yarnrc`), berry (`.yarnrc.yml`, replacing the view) and bun (bunfig.toml and the registry/token variables). Mechanism in `src/utils/REGISTRY.md`
  - `emptyRegistry?`: whether an empty `registry` / scope route fails the manager's run (npm's `{ registry: true, scopes: false }` by default; pnpm both, yarn and bun neither); an unusable value is recorded in `RegistryConfig.unusable` and fails discovery
  - `releaseAgeGate?(cwd, sources, npmrc)`: the manager's release-age gate from its own settings (#168): pnpm (one day unless set), bun and npm (off unless set). `managerRegistryConfig` sets it as `RegistryConfig.releaseAgeGate`; yarn berry sets it in its `registryConfig` instead. autd never proposes a version the gate holds
  - `pinMembers?(cwd)`: whether a package moving in a workspace member goes through `applyPinned` (root installs) instead of `apply`; `splitUpdates` then pins every moving row of it. yarn v1 only (#127)
  - `nodeVersion?(cwd)`: the Node the manager judges a package's `engines` by when the project sets one, else undefined (the running Node). pnpm only (#199). `plan` passes it to `filterPackages` as `node` with the label `<pm> nodeVersion`
  - `skipsEnginesExcluded?(cwd)`: default false. Whether the manager installs the newest in-range version whose `engines.node` fits its Node over a newer one that excludes it (#200); `plan` passes it to `filterPackages`, which walks such a row back (`src/utils/plan/CLAUDE.md`). npm only
- Adapters never log progress, group output, run the policy or catch failures: the pipeline does. `run` is bound to the step, so a failure is already a `StepError` (`.claude/context/ai-context/pipeline.md`, Command runner)
- Adding a manager: its name in `supportedManagers` (`names.ts`: the `--pm` choices and the CLI's startup load it without any adapter; `SupportedPackageManager` is derived from it, so `adapters`' `satisfies` fails to compile until the adapter is there, and `adapters.test.ts` fails when the order differs), its adapter directory and its entry in `adapters` (`index.ts`), its Tier 3 doc, and real captured fixtures in `__tests__/fixtures/<pm>/`. Nothing else changes
- Support the current version of each manager only, and verify its behavior with a real run rather than reading fields older versions honored

## Files

```
managers/
  adapter.ts      # ManagerAdapter, Workspace, WorkspaceManifest, Discovery, RunManager, ApplyPlan
  index.ts        # adapters registry (detection order), adapterFor(name), isSupportedManager
  names.ts        # supportedManagers: the manager names in adapters' order, importing no adapter (the CLI's options load it at startup, #109)
  workspaces.ts   # readManifest(), packageJsonWorkspace() (npm/yarn/bun), workspacePatterns(), readWorkspaceManifests() (the member map), nearestManifestDir(), listsMember(), packageJsonWorkspaceRoot(), memberAt(), pnpmWorkspacePatterns(yaml) (`pnpmPackages` of the text), pnpmProjectRoot(), pnpmWorkspaceRoot() (member runs, #123)
  pin.ts          # applyPinned(): cooldown fallbacks, pinned and restored before apply (#147)
  beyondRange.ts  # writeBeyondRange(cwd, plans, { style, writeCatalog, manager }): the one beyond-range writer, catalog rows then manifest rows, returning whether it wrote; pnpm's and bun's apply and applyPinned share it (#230)
  npm/ pnpm/ yarn/ bun/  # One adapter each, with its CLAUDE.md
```

## Workspace detection

- npm, yarn (v1 and berry), bun: the `package.json` `workspaces` field (array or `{packages: [...]}`); bun adds optional `catalog` / `catalogs` (top level or under `workspaces`)
- pnpm: `pnpm-workspace.yaml` with a non-empty `packages:` list (a file holding only settings or catalogs is not a workspace)

Discovery needs no manager flags: it reads each manifest in `Workspace.manifests`. The flags (`-r`, `--filter *`) belong to apply. Berry's `yarn.lock` has one entry per workspace keyed `<name>@workspace:<path>`, which `readBerryLock` maps to each workspace's dependencies.

The member map (`readWorkspaceManifests`) expands the patterns with `readdirSync`, not `fs.globSync`: literal directories, `{a,b}` braces, `*`, `?` and `[…]` / `[!…]` classes within a segment, `**` as a whole segment, and `!` negations applied after the positive patterns. It skips `node_modules`, dot-directories (unless the pattern segment starts with `.`) and symlinks, counts only directories with a package.json, and matches nothing for extglobs such as `@(a|b)` (logged at debug level). `listsMember` and `matchesWorkspacePatterns` apply the same `node_modules` and dot-directory skips to a path, so `packages/a/node_modules/lodash` is not a member of `packages/**`; they do not test for symlinks, which a cwd (a real path) never is.

## Apply: within range vs beyond range

- In-range updates (`target == wanted`) go to the manager by name with no manifest write: `npm update`, `pnpm update`, `bun update`, yarn v1 `upgrade name@<current spec>`, berry `up -R`. Each manager installs `wanted`; npm and yarn leave package.json alone, pnpm and bun raise the range floor (their own convention)
- Beyond-range updates get their spec rewritten to the target first (decorator kept), then the same command. `updatePackageJson(dir, …)` writes once per owning manifest (`ManifestPlan.beyondRange`). `splitCatalogUpdates()` routes a workspace's beyond-range rows: an owning spec of `catalog:` / `catalog:<name>` (read with `readSpec()`) writes that catalog's entry (`catalogs`: catalog → name → version, written one catalog at a time), every other row its own manifest. `writeBeyondRange()` (`beyondRange.ts`, #230) is that write, shared by pnpm's and bun's apply and `applyPinned`; a catalog row with no `writeCatalog` is an `apply` `StepError`. A single-package pnpm project with catalogs routes the same way, as a workspace of one manifest
- npm, pnpm and bun run one workspace-wide update command; yarn v1 runs `upgrade` for the root's own rows and moves members through the pin path (#127); berry runs `install` then `up -R` (Tier 3 docs)
- A manager may leave a row where it was (npm dedupes a member's `dayjs` onto the root's pin, pnpm keeps root `ms` at its lockfile version); the post-apply check reads each row's installed version member-first and reports `not applied by <pm> (installed …)`

## Cooldown fallbacks (`pin.ts`, #147)

A fallback moves below the version the manager picks when asked by name, so `applyPinned` runs before `apply` (which then gets `names` without those packages, and is skipped when nothing else moves): write the exact version into each row's manifest or catalog (`SaveStyle.pin`), `pinning.install`, put every touched file back byte for byte, write past-the-range rows to the version as a beyond-range row is written, `relock` if the adapter has one, then `install` again. npm 11.19.1, pnpm 12.14.0 and bun 1.4.4 keep the locked version when the range comes back; yarn 1.22.22 and 4.12.0 key `yarn.lock` by spec and resolve the restored range again to the newest, so the yarn adapter relocks (`yarn/CLAUDE.md`). Verified end to end on all five, 2026-10-27, with each frozen install passing after, and with a gapped range (`^0.7.1 || ^2.1.3`) on 2026-10-29 (#151). The restored range is the one written, so pnpm and bun don't raise its floor as their `update` would.

## Integration Points

- `src/pipeline.ts` hands each adapter `run`, the `Workspace` and the `ApplyPlan`; `plan` runs `src/utils/filterPackages.ts` with `project.config` and `adapter.overrides(root)`
- `src/utils/overrides.ts` (`overridesFromField`, `manifestOverrides`) and `src/utils/saveStyle.ts` (`readTextFile`, `yamlValue`) hold the generic readers adapters build on; adapters also use `manifests.ts`, `catalogs.ts`, `versionSpecs.ts` and `npmrcLoader.ts`
- The integration matrix's observations of each manager are in `__tests__/CLAUDE.md`
