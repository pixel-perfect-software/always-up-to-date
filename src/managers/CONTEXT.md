# Package Managers - Component Context

## Purpose
One adapter per package manager (npm, yarn, pnpm, bun): everything specific to that manager. The pipeline in `src/pipeline.ts` runs detect → discover → plan → apply → report the same way for every adapter.

## Current Status: Stable
All four package managers are implemented with workspace support. Yarn is one adapter for v1 and berry (2+), told apart by `isYarnBerry(cwd)`; berry has no `outdated`, so it discovers from `yarn info` and the registry.

## Component-Specific Development Guidelines
- An adapter is a plain object implementing `ManagerAdapter` (`adapter.ts`):
  - `name`, `lockfile`: what detection looks for
  - `readWorkspace(cwd)` → `{ isWorkspace, catalogs, manifests }`, read once per run and passed back to `discover` and `apply`. `manifests` is the root (`{ path: '.', name? }`) first, then each member directory the workspace patterns match, sorted by path
  - `discover(run, cwd, workspace)` → a `Discovery`: `{ kind: 'single', outdated: Record<string, PackageInfo> }` in a single-package project, `{ kind: 'workspace', entries: OutdatedEntry[] }` (one entry per package per owning manifest) in a workspace. The output parsers are exported pure functions (`parseNpmOutdated`, `parsePnpmOutdated`, `parseYarnOutdated`, `parseBunOutdated`, and for workspaces `parseNpmWorkspaceOutdated`, `parsePnpmWorkspaceOutdated`, `parseYarnWorkspaceOutdated`, `parseBunWorkspaceOutdated`) with direct tests on captured fixtures. Every row has a `current`: pnpm, yarn v1 and bun read it from their lockfile, while `npm outdated` reads node_modules and omits it for a package that isn't installed, so `parseNpmOutdated` takes it from `package-lock.json` (`readLockedVersions`), else `missing`
  - `apply(run, cwd, plan, workspace)`: writes the specs the manager does not write itself, then runs its update commands. `plan` is `{ names, withinRange, beyondRange, manifests }`; the first three are unions across manifests, `manifests` is the same split per manifest (`ManifestPlan[]`, root first), which a workspace apply reads
  - `installed?(run, cwd, rows)`: optional. The versions installed after apply, keyed by `rowKey`, for a manager whose installs can't be read from node_modules. The pipeline uses it instead of `readInstalledVersions` when present; yarn implements it (berry: `yarn info -A --json`, since PnP has no node_modules; v1: the node_modules reader)
  - `saveStyle(cwd)`: exact or prefix for specs that can't keep their shape, read from where the manager's current version keeps it
  - `overrides(cwd)`: packages pinned by an override field the manager enforces
- Adapters never log progress, group output, run the policy or catch failures: the pipeline does. `run` is bound to the step, so a failure is already a `StepError`
- Adding a manager: its adapter directory, its entry in `adapters` (`index.ts`) and `SupportedPackageManager`, and fixtures in `__tests__/fixtures/<pm>/`. Nothing else changes

## Major Subsystem Organization
```
managers/
  adapter.ts           # ManagerAdapter, Workspace, WorkspaceManifest, Discovery, RunManager, ApplyPlan
  index.ts             # adapters registry (detection order), adapterFor(name)
  workspaces.ts        # readManifest(), packageJsonWorkspace() (npm/yarn/bun), workspacePatterns(), readWorkspaceManifests() (the member map), workspaceOwner(), ownerPath()
  npm/index.ts         # npm adapter, parseNpmOutdated, readLockedVersions
  yarn/index.ts        # yarn adapter (v1 `outdated`/`upgrade`), parseYarnOutdated, isYarnBerry
  yarn/berry.ts        # berry: parseBerryInfo, parseBerryRegistry, discoverBerry, applyBerry, installedBerry
  pnpm/index.ts        # pnpm adapter, parsePnpmOutdated
  bun/index.ts         # bun adapter, parseBunOutdated
```

## Architectural Patterns

### Running commands (`src/commandRunner.ts`)
- `runCommand(packageManager, args, cwd, isSuccess?)` runs the manager with an argument array via `runProcess` and returns stdout. Build `args` as an array (`['update', ...names]`); shell quoting such as `'*'` must not appear in arguments
- Success is decided by a `SuccessCheck` over `{ exitCode, stdout }`; the default is exit 0. stderr is never a failure signal (yarn v1 on Node 24 always prints a DEP0169 warning); it is logged with `logger.debug`
- A failure throws `Command execution failed: <stderr, else stdout>`; a process with no numeric exit code (spawn failure, killed) throws the "unknown error" message. `runCommand` does not log failures; the command layer reports them once
- The pipeline hands each adapter `run(args, { isSuccess?, manifestWritten? })`, which is `runStep` bound to the step (`discover` or `apply`) and the manager: a failure rethrows as a `StepError`. Pass `manifestWritten: true` when autd rewrote a manifest before the apply command (npm, pnpm, bun); yarn writes its own manifest, so it passes `false`. Nothing catches: failures reach `src/commands/reportFailure.ts`
- Each manager's `outdated` passes its own `isOutdatedReport` check, because npm, pnpm and yarn v1 exit 1 both when packages are outdated and on real errors:

| Manager | `outdated` succeeds when |
|---------|--------------------------|
| npm | exit 0, or exit 1 with a JSON report that is not npm's `{ "error": { code, summary } }` |
| pnpm | exit 0, or exit 1 with a JSON object on stdout (errors leave stdout empty) |
| yarn v1 | exit 0, or exit 1 with a `{"type":"table"}` line (errors have none) |
| bun | exit 0 only (bun exits 0 when packages are outdated) |

Apply commands (`update`, `upgrade`, `install`) use the default.

### Package Detection (`src/detectPackageManager.ts`)
`detectPackageManager(cwd, pm?)`, first source that answers:
1. `pm`: the `--pm` option
2. package.json `packageManager` (`pnpm@12.14.0+sha512.…`): the name before the first `@`
3. package.json `devEngines.packageManager`: one `{ name }` or an array of them. Of the supported names, the one with a lockfile present, else the first
4. The lockfiles: each adapter's `lockfile`, in registry order npm -> yarn -> pnpm -> bun, last match wins. With more than one, a warning names the choice

A `packageManager` naming an unsupported manager falls through to `devEngines.packageManager`; when every declaration names only unsupported managers (`deno@2.5.0`), the `detect` step fails rather than guessing from a lockfile. Lockfiles that disagree with the chosen manager are logged at debug level as ignored, unless the declared manager has no lockfile while another has, which warns. A `--pm` that contradicts a declaration warns (Corepack may refuse it). The choice itself is logged at debug level. With nothing declared and no lockfile, `detect` fails and suggests `--pm`. A declared manager with no lockfile is used: its `outdated` then fails `discover` with the manager's own "run install" message.

### Workspace Detection
| Manager | Method | `outdated` command | Owning manifest comes from |
|---------|--------|--------------------|----------------------------|
| npm | `package.json` `workspaces` field (array or `{packages: [...]}`) | `outdated --json --long` (no `--workspaces`: that would drop the root's own dependencies) | `dependedByLocation` (`''` is the root); a name maps to one row or an array of rows |
| yarn v1 | `package.json` `workspaces` field | `outdated --json --recursive` | the `Workspace` column (a package name), resolved through `manifests` |
| yarn berry | `package.json` `workspaces` field | `info -A --json` (no `outdated`; see Yarn berry) | each workspace entry's value, `<name>@workspace:<path>` (path `.` for the root) |
| pnpm | `pnpm-workspace.yaml` with a non-empty `packages:` list (a file holding only settings or catalogs is not a workspace) | `outdated --json -r`, plus `--compatible` | each `dependentPackages[].location`, made relative to `cwd`; a `name@current` key loses its suffix |
| bun | `package.json` `workspaces` field + optional `catalog`/`catalogs` | `outdated --filter *` (two arguments) | the `Workspace` column (a package name), resolved through `manifests` |

Yarn v1 and bun print a root without a `name` as an empty `Workspace` cell (verified on yarn 1.22.22 and bun 1.4.0): `workspaceOwner()` reads `''` as the root only when the root manifest has no name, and fails `discover` for any other name no manifest declares.

The member map (`readWorkspaceManifests`) expands the patterns with `readdirSync`, not `fs.globSync`: literal directories, `{a,b}` braces, `*`, `?` and `[…]` / `[!…]` classes within a segment, `**` as a whole segment, and `!` negations applied after the positive patterns. It skips `node_modules`, dot-directories (unless the pattern segment starts with `.`) and symlinks, counts only directories with a package.json, and matches nothing for extglobs such as `@(a|b)` (logged at debug level). An owner a manager reports outside the root (`..`, absolute) fails `discover` (`ownerPath`), since apply writes the owner's package.json. Only yarn and bun need it for discovery; npm and pnpm take owners from paths.

`catalogs` lists catalog names (pnpm: `catalog` and the keys of `catalogs:` in pnpm-workspace.yaml; bun: the same fields in package.json). The pipeline logs the workspace once per run, and the catalogs when it is a workspace.

## Integration Points
- `src/pipeline.ts`: `check(project)`, `plan(project, outdated, targets?)`, `update(project, { targetPackages?, discovered? })`, where a `Project` is `{ cwd, config, adapter }`. `openProject(cwd, { pm? })` (`src/project.ts`) builds it with `adapterFor(detectPackageManager(cwd, pm))` after loading the config
- `plan` runs `src/utils/filterPackages.ts` with `project.config` and `adapter.overrides(cwd)`
- `src/utils/files.ts` `updatePackageJson(dir, …)` writes version updates before running the manager's update command (npm, pnpm, bun), only for packages moving past their range, once per owning manifest (`ManifestPlan.beyondRange`). `splitCatalogUpdates()` routes a workspace's beyond-range rows: an owning spec of `catalog:` (read with `readSpec()`) writes the catalog, every other row its own manifest
- `src/utils/overrides.ts` (`overridesFromField`, `manifestOverrides`) and `src/utils/saveStyle.ts` (`readTextFile`, `yamlValue`) hold the generic readers adapters build on

### Discovery: names
Every parser's report goes through `toManifestNames()` (single-package) or `toEntryManifestNames()` (workspace, each entry re-keyed by its owning manifest), so results are keyed by the package.json name. In a workspace the entries are then folded by `foldWorkspaceEntries()` into one `PackageInfo` per name carrying `workspaces`. An `npm:` alias (`"dj": "npm:dayjs@1.11.9"`) otherwise comes back as `dj:dayjs@1.11.9` (npm) or the target name `dayjs` (pnpm, bun); yarn v1 reports `dj` but with `exotic` as wanted and latest, which the policy holds as an invalid version. The managers' own `update dj` accepts the alias key.

### Discovery: `wanted`
Every parser fills `PackageInfo.wanted`, the highest version the manifest range allows: npm's `wanted`, yarn v1's `Wanted` column, bun's `Update` column. pnpm's own `wanted` is the lockfile's version, so pnpm also runs `outdated --compatible` (in parallel) and takes `wanted` from its `latest`.

### Apply: within range vs beyond range
- In-range updates (`target == wanted`) go to the manager by name with no manifest write: `npm update`, `pnpm update`, `bun update`, yarn `upgrade name@<current spec>`. Each manager installs `wanted`; npm and yarn leave package.json alone, pnpm and bun raise the range floor (their own convention)
- Beyond-range updates get their spec rewritten to the target first (decorator kept), then the same command
- npm: writes each manifest in `plan.manifests` that has beyond-range rows, then one `npm update <names>` at the root. No `--workspaces`: that would skip the root's own dependencies, while a root `npm update` moves every workspace's ranges (verified on npm 11.19.1, including a member spec autd just rewrote, so no `install` is needed between)
- pnpm: a workspace writes catalog rows to pnpm-workspace.yaml and the rest to their own package.json, runs `install` if anything was written, then `update -r <in-range names>`. A single-package project with catalogs keeps its own branch (both rewrites, `install`, `update <names>`)
- bun: a workspace without catalogs writes each manifest, then `update <names> --filter *`. With catalogs it writes catalog entries (`updateBunCatalogs`) and the rest per manifest, runs `install` if anything was written, then `update <in-range names> --filter *`. A single-package project always takes the plain path
- A manager may leave a row where it was (npm dedupes a member's `dayjs` onto the root's pin, pnpm keeps root `ms` at its lockfile version); the post-apply check reads each row's installed version member-first and reports `not applied by <pm> (installed …)`

### Yarn apply (`src/managers/yarn/index.ts`)
- yarn writes the manifest itself: autd passes `name@spec` descriptors from `buildUpdateDescriptors()` and never pre-writes `package.json` (v1 then fails with "Outdated lockfile")
- v1 runs `yarn upgrade <descriptors>`; it has no `update`. In a v1 workspace `upgrade` at the root only touches the root manifest, so each manifest in `plan.manifests` gets its own command: `upgrade` for the root, `workspace <name> upgrade` for a member (the name comes from `Workspace.manifests`; a member without one is an `apply` StepError), then one `install` if any member command ran, since a member upgrade leaves node_modules unlinked. No `--recursive`: v1 ignores it
- `isYarnBerry(cwd)` (exported here; also decides save style and overrides): `packageManager: yarn@2+` wins; otherwise a `.yarnrc.yml` means berry
- Packages a manifest does not list are skipped with a warning naming it: v1 `upgrade` at a workspace root adds them as root dependencies

### Yarn berry (`src/managers/yarn/berry.ts`)
Berry has no `outdated` (`yarn outdated` runs a script of that name), so v1's path is not used when `isYarnBerry(cwd)`. Verified on yarn 4.12.0 with PnP and with `nodeLinker: node-modules`.
- Discovery: `yarn info -A --json` (NDJSON; `-A` is needed or a workspace project's root entry is missing). Each workspace is an entry whose value is `<name>@workspace:<path>`, with `children.Dependencies: [{ descriptor, locator }]`. The descriptor gives the manifest key and range, the locator the locked version. `parseBerryInfo` reads only workspace entries. Peer-dependent packages are virtual (`debug@virtual:<hash>#npm:~4.3.1`): the `virtual:<hash>#` part is stripped. A builtin-patched package (typescript, fsevents, resolve) is `typescript@patch:typescript@npm%3A^5.4.0#optional!builtin<compat/typescript>`: the URL-decoded npm range between `patch:<name>@` and `#` is used (a `patch:` without `builtin<` is left out). An alias `dj@npm:dayjs@^1.11.9` queries `dayjs` and keeps `dj` as the row name. `workspace:`, `portal:`, `link:`, `file:`, git and URL descriptors are left out
- Then `yarn npm info <names…> --fields dist-tags,versions --json`, 50 names per call, through the registries and auth in `.yarnrc.yml` (one JSON line per package). One unknown package fails the whole call, which fails `discover` with yarn's message. `wanted` is `semver.maxSatisfying(versions, range)` (prereleases excluded unless the range names one), never below `current`; `latest` is `dist-tags.latest`; `current` is the locked version. A row is outdated when `latest` or `wanted` is newer than `current`. A dependency whose range or lock is not semver is left out
- A single-package project returns `{ kind: 'single' }` from the root workspace; a workspace project returns `{ kind: 'workspace' }` entries sorted by name, then root first, with the owner from the `@workspace:` path (`ownerPath` rejects one outside the root)
- Apply (`applyBerry`): each manifest in `plan.manifests` with beyond-range rows is written by `updatePackageJson` (the save style comes from `.yarnrc.yml`), then `yarn install --no-immutable` if anything was written (`--no-immutable`: on CI yarn refuses an install that changes `yarn.lock`), then `yarn up -R <withinRange…>` if any. `up -R` re-resolves those packages to the highest version their existing ranges allow, project-wide, and leaves package.json alone. `yarn up name@range` would set that range in every workspace using the package, so it is not used. The project-wide in-range command is what `holdTogether` already assumes. `up -R` also re-resolves transitive copies of those packages within their own ranges, which the plan doesn't list. Locator references may carry `::key=value` parameters (`::__archiveUrl=…` from registries with nonstandard tarball URLs, `::version=…` on patches); `npmSpec` drops them before reading the version
- Post-apply check: `installed` re-runs `yarn info -A --json` and reads the locked version of each row from its own workspace
- Not covered: yarn `catalog:` specs (the spec is not rewritten, so a beyond-range move is reported `not applied`); `.yarnrc.yml` registry config for the cooldown (see `src/utils/CONTEXT.md`); peer-conflict holds under PnP (`peers.ts` reads node_modules)
