# Workspace member manifests (#59)

Issue: #59. Planned 2026-10-23. Branch `fix/59-workspace-member-manifests`, stacked on #94.

- [x] Phase 1: Discovery keeps the owning manifest
- [x] Phase 2: Plan and verify per manifest
- [x] Phase 3: Apply writes each owning manifest

Each phase is one commit and leaves `pnpm run format-and-lint`, `pnpm run check-types`, `pnpm test` and `pnpm run build` green. No new dependencies. Do not commit, push or switch branches unless the orchestrator says so.

Scratch captures (real output, paths scrubbed to `/project`) live in
`/private/tmp/claude-501/-Users-tylerrobertson-personal-dev-always-up-to-date/6a97c94d-c45b-4048-ab0a-4467299b24bf/scratchpad/ws59/captures/`. The evidence workspace copies, one per manager (`npm/`, `pnpm/`, `yarn/`, `bun/`), are in the parent `ws59/` directory: copy them before running anything that mutates them.

## Overview

**Goal:** in workspace projects, autd discovers, plans, applies and reports each outdated package once per manifest that declares it. Single-package projects keep exactly what they do today.

**Acceptance criteria**
1. Discovery keeps the owning manifest (`'.'` for the root, `packages/a` for a member) for every outdated entry, on npm, pnpm, yarn v1 and bun. npm discovery covers root dependencies (`--workspaces` dropped). pnpm `ms@2.1.1` keys become `ms`. yarn v1 and bun rows no longer overwrite each other.
2. `check --json` keeps the `Record<name, PackageInfo>` shape. In workspace projects each value gains `workspaces: [{ path, current, wanted }]`; top-level `current`/`wanted` come from the root's row, else the first member's (user decision, 2026-10-23).
3. `update --json`: one row per (package, manifest); in workspace projects each row has `workspace`.
4. Apply writes the owning manifest for beyond-range rows (npm, pnpm, bun: autd writes it; yarn v1: `yarn workspace <name> upgrade`). In-range rows reach every manifest.
5. The post-apply check reads `<member>/node_modules/<name>` first, then the root's; a row the manager left in place is `not applied by <pm> (installed …)` (npm's dedupe of `dayjs` in `@ws/b`, pnpm's dedupe of root `ms` to 2.1.2).
6. Human output shows each row's workspace (outdated, updating, would-skip, left-in-place, cooldown blocks).
7. Single-package `check --json`, `update --json` and `update --dry-run --json` stay byte-identical: a snapshot test written against the unchanged code and a real base-vs-new diff enforce it.

**Decisions (beyond the user's)**
- **npm owner from `npm outdated --json --long`:** `dependedByLocation` is `''` for the root and `packages/a` for a member. Verified on npm 11.19.1 on 2026-10-23 (capture `captures/npm-outdated-long.stdout`). The plain `dependent` field is a directory basename and is ambiguous.
- **A package moves in every manifest or none (the "together" rule).** In-range commands for npm, pnpm, bun are workspace-wide (root `npm update <names>` moves members too, verified; `pnpm update -r`; `bun update --filter '*'`). If one row of a package is held while its range allows newer (cooldown, peer conflict, override: target-dependent holds), the package's other moving rows are held with `held with <path> (<that row's reason>)`. Exact pins (`wanted == current`) never trigger it.
- **One workspace-wide in-range command for npm, pnpm, bun.** Only yarn v1 runs a command per workspace.
- **Human root label `(root)`**; members show their path; JSON uses `'.'`.
- **Interactive mode: one choice per package**, listing its manifests; targeting stays by name.
- **Workspace `check --json` values are clean:** `{ name, current, wanted, latest, workspaces }`; manager pass-through fields are dropped in workspace projects only.

## Technical Architecture

### Types

```ts
// src/types.ts
/** One manifest's versions of an outdated package, in a workspace project. */
export interface WorkspaceVersion {
  /** The manifest's directory relative to the root, POSIX separators; '.' is the root. */
  path: string
  current: string
  wanted: string
}

export interface PackageInfo {
  name: string
  current: string
  wanted: string
  latest: string
  /** Workspace projects only: each manifest declaring the package, root first, then by path.
   *  `current`/`wanted` above repeat the root's, else the first member's. */
  workspaces?: WorkspaceVersion[]
}

/** Discovery's unit in a workspace project: one package as one manifest declares it. */
export interface OutdatedEntry {
  /** As the manager reports it; the pipeline re-keys it by the owner's dependency key. */
  name: string
  current: string
  wanted: string
  latest: string
  /** The owning manifest's directory relative to the root ('.' = root). */
  workspace: string
}

export interface UpdateResult {
  name: string
  /** Workspace projects only: the manifest this row belongs to. Absent in single-package projects. */
  workspace?: string
  // ...unchanged fields
}

/** One manifest's share of the plan (Phase 2). */
export interface ManifestPlan {
  path: string
  withinRange: string[]
  beyondRange: Record<string, string>
}
```

```ts
// src/managers/adapter.ts
export interface WorkspaceManifest {
  path: string
  name?: string
}

export interface Workspace {
  isWorkspace: boolean
  catalogs: string[]
  /** The root ({ path: '.' }) first, then each member directory the workspace patterns
   *  match, sorted by path. Only the root outside a workspace. */
  manifests: WorkspaceManifest[]
}

/** What `discover` found, in the shape the project calls for. */
export type Discovery =
  | { kind: 'single'; outdated: Record<string, PackageInfo> } // today's object, untouched
  | { kind: 'workspace'; entries: OutdatedEntry[] }

// discover(run, cwd, workspace): Promise<Discovery>

export interface ApplyPlan {
  /** Unions across manifests: a package can be within range in one manifest and beyond it in
   *  another. A beyond-range target is always `latest`, so it is one version per name. */
  names: string[]
  withinRange: string[]
  beyondRange: Record<string, string>
  /** Each manifest with something moving, root first. A single-package project has the root only. */
  manifests: ManifestPlan[]
  discovered: Record<string, PackageInfo> // removed in Phase 3 (bun was its only reader)
}
```

### How the record and the rows relate in the pipeline

```
adapter.discover → Discovery
  single:    toManifestNames(cwd, outdated) → Record                          (byte-identical path)
  workspace: toEntryManifestNames(cwd, entries)   // aliases re-keyed per owning manifest
             → foldWorkspaceEntries(entries) → Record<name, PackageInfo + workspaces>
Record = what check prints and returns, and what --interactive passes back as `discovered`.
It is lossless: expandWorkspaces(record) gives one row per workspaces[] element
({ name, workspace, current, wanted, latest }), or the info itself when there is no `workspaces`.
filterPackages(record) expands it → one UpdateResult per row (with `workspace` when present)
splitUpdates(results) → names / withinRange / beyondRange (unions) + manifests (ManifestPlan[])
adapter.apply(plan) → readInstalledVersions(cwd, movingRows) keyed by rowKey → checkApplied
```

### Discovery per manager (workspace projects; single-package commands and parsers unchanged)

| Manager | Command                                           | Owner comes from                                                                  | New exported parser                                   |
| ------- | ------------------------------------------------- | --------------------------------------------------------------------------------- | ----------------------------------------------------- |
| npm     | `outdated --json --long` (drop `--workspaces`)    | `dependedByLocation` (`''` → `'.'`); a value may be an object or an array of rows | `parseNpmWorkspaceOutdated(stdout, locked)`           |
| pnpm    | `outdated --json -r` + `--compatible` (unchanged) | each `dependentPackages[].location`, made relative to `cwd`                       | `parsePnpmWorkspaceOutdated(report, compatible, cwd)` |
| yarn v1 | `outdated --json --recursive` (unchanged)         | `Workspace` column (a package name) → `manifests`                                 | `parseYarnWorkspaceOutdated(output, ownerOf)`         |
| bun     | `outdated --filter *` (unchanged)                 | 5th column `Workspace` (a package name) → `manifests`                             | `parseBunWorkspaceOutdated(output, ownerOf)`          |

### Apply per manager (workspace path)

| Manager    | autd writes                                                                                             | Commands                                                                                                                                              |
| ---------- | ------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm        | `updatePackageJson(join(cwd, m.path), m.beyondRange)` per manifest                                      | `npm update <names>` at the root, without `--workspaces`                                                                                              |
| pnpm       | rows whose owning spec is `catalog:` → `updatePNPMWorkspaceYAML`; others → that manifest's package.json | `install` if anything was written; `update -r <withinRange>`                                                                                          |
| yarn v1    | nothing (yarn writes)                                                                                   | root: `upgrade <descriptors>`; each member: `workspace <name> upgrade <descriptors>`; `install` if any member command ran (verified needed to relink) |
| yarn berry | unchanged: `up <root descriptors>` (#79 goes per workspace from `manifests`)                            |                                                                                                                                                       |
| bun        | `catalog:` rows → `updateBunCatalogs`; others → that manifest's package.json                            | no catalogs: `update <names> --filter *`; catalogs: `install` if written, then `update <withinRange> --filter *`                                      |

### Member map (`src/managers/workspaces.ts`)

Expanded with `readdirSync`, not `fs.globSync` (Node 22+, would block M3's Node 20 floor); avoid `Object.groupBy` too. Supported: literal directories; `*` and `?` within a segment; `**` as a whole segment; `!` negations applied after the positive patterns to the relative path. The walk skips `node_modules`, dot-directories (unless the segment itself starts with `.`) and symlinked directories. Braces, character classes and extglobs match nothing and log at debug level. Only directories with a `package.json` count; the root itself is excluded; results deduped and sorted. Only yarn and bun need the map for discovery; npm and pnpm attribute owners from paths.

## Phase 1: Discovery keeps the owning manifest

**Step 0, before touching code: pin today's single-package JSON.** Add `__tests__/singlePackageJson.test.ts` (describe.each over the four managers): in a temp dir holding the aliases.test.ts manifest, mock `runProcess` with the existing `<pm>/outdated-alias.stdout` (plus `pnpm/outdated-alias-compatible.stdout`), run `check`, `plan`, and `update` with a mocked apply (default config and `{ beyondRange: 'major' }`), `expect(JSON.stringify(x, null, 2)).toMatchSnapshot()`. Run it on the unchanged tree so the snapshot records today's bytes. No later phase may update this snapshot. (The orchestrator commits it on its own first: "Pin single-package JSON output".)

**Files**
- `src/types.ts`: `WorkspaceVersion`, `PackageInfo.workspaces?`, `OutdatedEntry`.
- `src/managers/adapter.ts`: `WorkspaceManifest`, `Workspace.manifests`, `Discovery`; `discover` return type. Re-export from `src/managers/index.ts`.
- `src/managers/workspaces.ts`: `workspacePatterns(manifest): string[]` (array or `{ packages }`); `readWorkspaceManifests(cwd, patterns): WorkspaceManifest[]` (root first with `name` from its package.json, then expanded members); `workspaceOwner(manifests, manager): (workspaceName) => path`, throwing `new StepError('discover', \`${manager} reported workspace "${name}", which no manifest matched by the workspaces patterns declares\`)`on no match (root fallback only for the exact value the unnamed-root capture shows; see the real-run steps).`readManifest`, `hasWorkspacesField` stay.
- `src/managers/npm/index.ts`: `readWorkspace` adds `manifests`. `discover`: single → same command, `{ kind: 'single', outdated: parseNpmOutdated(...) }`; workspace → `['outdated', '--json', '--long']`, `{ kind: 'workspace', entries: parseNpmWorkspaceOutdated(stdout, readLockedVersions(cwd)) }`. Parser: for each `[key, value]` and each row of `[value].flat()`: `workspace = row.dependedByLocation || '.'` (throw if absent: `--long` is always passed); `current = row.current ?? locked[\`${loc}/node_modules/${alias}\`] ?? locked[\`node_modules/${alias}\`] ?? 'missing'`with`alias = key.split(':')[0]`, the first lookup for members only (#91's lock fallback with the member lock path).
- `src/managers/pnpm/index.ts`: replace `listsWorkspacePackages` with `workspacePackagePatterns(yaml): string[]` reading exactly the block and single-line flow lists recognised today (quotes stripped), so `isWorkspace = patterns.length > 0` stays identical. `readWorkspace` adds `manifests`. `parsePnpmWorkspaceOutdated(report, compatible, cwd)`: name = key with a `@${row.current}` suffix stripped; one entry per `dependentPackages[]` element with `workspace = toPosix(path.relative(cwd, location)) || '.'` (a `..`-leading or absolute result is a `StepError('discover')`); expand the compatible report the same way and match by (workspace, name): `wanted = compat?.latest ?? row.wanted`.
- `src/managers/yarn/index.ts`: `readWorkspace` adds `manifests`; `parseYarnWorkspaceOutdated(output, ownerOf)` finds column indexes from `data.head` (`Package`, `Current`, `Wanted`, `Latest`, `Workspace`), one entry per body row; bad JSON propagates (unlike the single parser).
- `src/managers/bun/index.ts`: `readWorkspace` adds `manifests`; `parseBunWorkspaceOutdated(output, ownerOf)` takes column positions from the header row, strips ` (dev)` and similar markers, keeps today's `current !== latest` filter.
- `src/utils/manifestNames.ts`: extract `manifestNamer(dir): (reported) => name` (today's alias logic); `toManifestNames` keeps its behavior on top of it; add `toEntryManifestNames(cwd, entries)` (one cached namer per `entry.workspace`).
- New `src/utils/workspaceRows.ts`: `foldWorkspaceEntries(entries)` groups by name in first-appearance order, `workspaces` sorted `'.'` first then by path, value key order `name, current, wanted, latest, workspaces` (`workspaces` present even with one row); `workspaceLabel(path)` → `'(root)'` or the path.
- `src/utils/rows.ts`: `toOutdatedRows(name, info, releaseAge)` → one row per `workspaces` element (with `workspace`, that row's `current`/`wanted`), else `[toOutdatedRow(...)]`. Export from `src/utils/index.ts`.
- `src/utils/logger.ts`: `OutdatedRow.workspace?: string`; `computeWidths` adds `workspace` (0 when no row has one); `formatRow` prints a gray `workspaceLabel(...)` column after the name only when `widths.workspace > 0`, so single-package lines are unchanged.
- `src/pipeline.ts`: `discover` branches on `kind` as in the diagram; prints with `toOutdatedRows`; logs `manifests` paths at debug level.

**Fixtures** (scrubbed to `/project`; from the captures directory)
- `__tests__/fixtures/npm/outdated-workspace.stdout` ← `npm-outdated-long.stdout` (the `--long` capture; `npm-outdated-root.stdout` is not committed).
- Optional: `npm/outdated-workspace-no-node-modules.stdout` + `npm/workspace.package-lock.json` from the same project after removing node_modules (commit only if npm still lists member rows).
- `pnpm/outdated-workspace.stdout` ← `pnpm-outdated-r.stdout`; `pnpm/outdated-workspace-compatible.stdout` ← `pnpm-outdated-r-compatible.stdout` (both still contain absolute scratch paths in `location`: scrub them to `/project` and `/project/packages/<x>` when copying).
- `yarn/v1-outdated-workspace.stdout` ← `yarn-outdated.stdout` (captured with plain `yarn outdated --json`; recapture with the adapter's exact `yarn outdated --json --recursive`).
- `bun/outdated-workspace.stdout` ← `bun-outdated-filter.stdout`.
- Unnamed-root captures for yarn and bun (real-run step 3).
- `__tests__/fixtures/index.ts` helper `writeWorkspaceProject(cwd, { pnpm?: boolean })` writing the evidence manifests: root `ws-root` `{dayjs:"1.11.9", ms:"~2.1.1"}`, `packages/a` `@ws/a` `{ms:"2.1.2"}`, `packages/b` `@ws/b` `{debug:"~4.3.1", dayjs:"^1.11.9"}`, plus `workspaces: ['packages/*']` or `pnpm-workspace.yaml` (project files, not manager output). pnpm tests substitute the scrubbed root with `readFixture(...).replaceAll('/project', cwd)`.

**Tests**
- New `__tests__/managers/workspaces.test.ts` (temp dirs): array and `{packages}` forms; literal dir, `dir/*`, `**` (skipping node_modules and dot-dirs), a negation; a dir without package.json skipped; an unnamed member kept; root first; sorted; `workspaceOwner` resolves names and throws `StepError` `discover` for unknown names.
- Parser tests in npm/pnpm/yarn/bun test files on the new fixtures, each parsing to the five entries: dayjs `.` 1.11.9/1.11.9; dayjs `packages/b` 1.11.9/1.11.23; debug `packages/b` 4.3.1/4.3.7; ms `.` 2.1.1/2.1.3; ms `packages/a` 2.1.2/2.1.2. pnpm also asserts no `ms@2.1.1` name survives.
- New `__tests__/managers/workspaceDiscovery.test.ts`: describe.each over the four managers in a temp workspace; `check` returns the same record from every manager (dayjs top-level from root 1.11.9/1.11.9 with workspaces `.` and `packages/b`; debug top-level from `packages/b`; ms top-level from root 2.1.1/2.1.3 with `.` and `packages/a`; latest 1.11.23 / 4.4.3 / 2.1.3), and `logger.printOutdatedRows` received rows carrying `workspace`. npm and bun also check the discovery arguments.
- `__tests__/utils/workspaceRows.test.ts`: fold ordering, top-level choice.
- `__tests__/utils/manifestNames.test.ts`: an alias only a member declares is re-keyed by that member's key.
- `__tests__/utils/logger.test.ts`: workspace column when rows carry `workspace`; identical lines when none do.
- `__tests__/managers/pnpm.test.ts`: the existing `readWorkspace` cases stay green (guards `isWorkspace` parity); add a `manifests` case.

**Docs:** `src/managers/CLAUDE.md` (the `Discovery` contract, workspace table with npm `--long` and no `--workspaces`, owner sources, member map); `src/utils/CLAUDE.md` (workspaceRows, `toEntryManifestNames`); `src/commands/CLAUDE.md` (`check --json` workspace shape); `.claude/context/ai-context/docs-overview.md`; CLAUDE.md "Workspace Detection".

**Real-run check (end of Phase 1)**
1. Build. In each manager's copy of the evidence workspace, `node <repo>/dist/index.js check`: rows show `(root)`, `packages/a`, `packages/b`. `check --json` matches the cross-manager test's record on all four.
2. Confirm root rows in the npm capture have `"dependedByLocation": ""` (done 2026-10-23).
3. Remove `name` from the root package.json in yarn and bun copies; capture their `outdated`; record what the Workspace column shows; implement the root fallback for exactly that value; add those captures as fixtures with a test.
4. Single-package byte check per manager on a fresh scratch project: `diff <(node <base>/dist/index.js check --json) <(node dist/index.js check --json)` empty.

## Phase 2: Plan and verify per manifest

**Files**
- `src/types.ts`: `UpdateResult.workspace?`, `ManifestPlan`.
- `src/utils/workspaceRows.ts`: `expandWorkspaces(outdated)`.
- `src/utils/filterPackages.ts`: iterate over `expandWorkspaces(outdatedPackages)`; every result literal starts `{ name, ...(workspace === undefined ? {} : { workspace }), current, wanted, latest, ... }` (not `cond && {...}`) so single-package key order is exactly today's. Restructure the cooldown return so `holdTogether` runs last:

```ts
const holdTogether = (results: UpdateResult[]): UpdateResult[] => {
  const blocking = new Map<string, UpdateResult>()
  for (const r of results) {
    if (r.workspace === undefined || r.updated || blocking.has(r.name)) continue
    if (
      semver.valid(r.current) &&
      semver.valid(r.wanted) &&
      semver.gt(r.wanted, r.current)
    )
      blocking.set(r.name, r)
  }
  if (blocking.size === 0) return results
  return results.map((r) => {
    const by = blocking.get(r.name)
    if (!by || !r.updated) return r
    const where = by.workspace === '.' ? 'the root' : by.workspace
    return {
      ...r,
      target: undefined,
      updated: false,
      updateType: stepType(r.current, r.latest),
      reason: `held with ${where} (${by.reason})`,
    }
  })
}
```

`splitUpdates` also returns `manifests: ManifestPlan[]` grouped by `workspace ?? '.'`, root first then by path; unions deduped in first-appearance order. Single-package: `[{ path: '.', withinRange, beyondRange }]` equal to the top-level fields.
- `src/managers/adapter.ts`: `ApplyPlan.manifests` (adapters ignore it until Phase 3).
- `src/utils/installed.ts`: `rowKey(row)` = `row.name` without `workspace` (existing callers/tests hold), else `` `${workspace}:${name}` ``. `readInstalledVersions(cwd, rows: { name; workspace? }[])` caches declared names per manifest dir and reads `<cwd>/<ws>/node_modules/<name>` then `<cwd>/node_modules/<name>` (one lookup for `'.'`). `checkApplied` looks up `installed[rowKey(result)]`.
- `src/pipeline.ts`: pass `manifests` in the apply plan; `readInstalledVersions(cwd, results.filter((r) => r.updated))`.
- `src/utils/rows.ts`: `toUpdatingRow` carries `workspace`; add and export `toSkippedRow(result)`.
- `src/utils/logger.ts`: `notAppliedSummary` and `cooldownSummary` carry `workspace`.
- `src/commands/update.ts`: dry-run skipped rows via `toSkippedRow`; interactive builds one choice per name labelled `` `${name}: ${current} → ${target} (${updateType}${beyond}) in ${labels}` `` from the first row, `value: name`; `in …` only when rows carry a workspace (single-package labels unchanged).

**Tests**
- `__tests__/utils/filterPackages.test.ts`: one result per (name, workspace) with `workspace` second in key order; single-package results have no `workspace` key (`Object.keys` equality); a `hold` rule holds every row; the together rule (root `~1.10.0` at 1.10.0 → wanted 1.10.8, `packages/m` `^1.0.0` wanted 1.11.23, cooldown 7 with 1.11.23 two days old and 1.10.8 old → both held, root's reason `held with packages/m (cooldown: …)`); a pinned held row (wanted == current) does not block; `splitUpdates` manifests including a name within range in one manifest and beyond in another.
- `__tests__/utils/workspaceRows.test.ts`: `expandWorkspaces(foldWorkspaceEntries(e))` equals `e` as a set.
- `__tests__/utils/installed.test.ts`: calls become row objects; member nested copy beats root hoisted; member falls back to root hoisted; a name the member doesn't declare is skipped; pnpm member symlink followed.
- `__tests__/pipeline.test.ts`: npm workspace on the new fixture; install old versions (root node_modules dayjs 1.11.9, ms 2.1.1, debug 4.3.1; `packages/a/node_modules/ms` 2.1.2); fake apply installs debug 4.3.7 and ms 2.1.3 at the root. Expected: dayjs `.` held `patch beyond the range`; dayjs `packages/b` `not applied by npm (installed 1.11.9)`; debug `packages/b` updated; ms `.` updated; ms `packages/a` held.
- `__tests__/commands/update.test.ts`: interactive offers one choice per package; dry-run skipped rows carry `workspace`.
- `__tests__/utils/logger.test.ts`: updating and skipped blocks show the column.
- The singlePackageJson snapshot passes unchanged.

**Docs:** `src/utils/CLAUDE.md` (per-row filterPackages, the together rule after cooldown, per-row installed.ts); `src/commands/CLAUDE.md` (`update --json` `workspace`; interactive by package); `src/managers/CLAUDE.md` (`ApplyPlan.manifests`).

**Real-run check (end of Phase 2)**
1. `update --dry-run --json` on each workspace copy: one row per (package, manifest) with `workspace`; dayjs `.` and ms `packages/a` held `patch beyond the range`; human dry-run shows labels.
2. Throwaway npm copy, `update --json`: apply still uses `--workspaces` in this phase, so ms `.` must come back `not applied by npm (installed 2.1.1)`.
3. Per manager, single-package `update --dry-run --json` and `update --json` on fresh copies, base vs new: identical bytes.

## Phase 3: Apply writes each owning manifest

**Files**
- `src/utils/files.ts`: `readSpec(dir, name)` (reads `DEPENDENCY_FIELDS` in order); `splitCatalogUpdates(cwd, manifests)` → `{ catalog: Record<string,string>; byManifest: { path; versions }[] }` (beyond-range rows whose owning spec starts `catalog:` go to `catalog`). Delete `identifyCatalogPackages` and its tests once nothing imports it (grep first).
- `src/managers/npm/index.ts`, one path for every project:

```ts
const style = npm.saveStyle(cwd)
const written = manifests.filter((m) => Object.keys(m.beyondRange).length > 0)
for (const m of written)
  await updatePackageJson(path.join(cwd, m.path), m.beyondRange, style)
// `npm update` at the root moves every workspace's ranges too; `--workspaces` would skip the root's own.
await run(['update', ...names], { manifestWritten: written.length > 0 })
```

Single-package: same write and same `['update', ...names]` as today.
- `src/managers/pnpm/index.ts`: the `if (!isWorkspace)` branch keeps today's code exactly. Workspace branch: write via `splitCatalogUpdates` (YAML for catalog rows, each manifest's package.json for the rest), then `['install']` if anything was written, then `['update', '-r', ...withinRange]` if non-empty.
- `src/managers/bun/index.ts`: `if (!isWorkspace)` keeps today's simple path. Workspace branch: `splitCatalogUpdates` writes (`updateBunCatalogs` and per-manifest `updatePackageJson`); with `catalogs.length === 0` run `['update', ...names, '--filter', '*']`; else `['install']` if written, then `['update', ...withinRange, '--filter', '*']`.
- `src/managers/yarn/index.ts`: single-package and berry unchanged. v1 workspace: loop over `manifests` (root first): `buildUpdateDescriptors(path.join(cwd, m.path), { withinRange: m.withinRange, newVersions: m.beyondRange, style })`; warn about `notInManifest` (root keeps today's text; a member gets `` `Skipped ${names}: not listed in ${m.path}/package.json.` ``); run `['upgrade', ...d]` for the root or `['workspace', name, 'upgrade', ...d]` with `name` from `workspace.manifests` (a member without a name throws `StepError('apply', …)`); after all, `['install']` if any member command ran; `manifestWritten: false` throughout.
- `src/managers/adapter.ts`, `src/pipeline.ts`: remove `ApplyPlan.discovered`.

**Tests**
- New `__tests__/managers/workspaceApply.test.ts`, describe.each over the four managers, end to end via `update(projectFor(...))` on the workspace fixtures and temp workspace, asserting exact argument arrays (name order = fixture first appearance). Default config: npm `['update', <names>]` (no `--workspaces`); pnpm `['update', '-r', …]`; yarn `['upgrade', 'ms@~2.1.1']`, `['workspace', '@ws/b', 'upgrade', …]`, `['install']`; bun `[…, '--filter', '*']`; no autd manifest writes. `{ beyondRange: 'patch' }`: npm/pnpm/bun write root `dayjs` → `"1.11.23"` and `packages/a` `ms` → `"2.1.3"`, `packages/b` untouched; pnpm runs `install` before `update -r`; yarn passes `dayjs@1.11.23` in the root `upgrade` and `['workspace', '@ws/a', 'upgrade', 'ms@2.1.3']`, no pre-write. A failed command after a write rejects with `manifestWritten: true` on npm/pnpm/bun. Catalog routing on pnpm and bun via an autd-level `discovered` record: a member whose spec is `catalog:` writes the catalog file and leaves its package.json alone; a direct-spec row of the same name writes only its own manifest.
- Extend the `__tests__/pipeline.test.ts` npm workspace case with the apply command and the beyond-range member write; post-apply uses member-first reads.
- Existing `applyRanges`, `reuseDiscovery`, `stepFailures`, `yarn.test.ts` (incl. "does not hand yarn a package the root manifest does not list") and singlePackageJson pass unchanged: the single-package guard.

**Docs:** `src/managers/CLAUDE.md` (per-manager apply, yarn members via `yarn workspace <name> upgrade` + `install`, catalog routing); CLAUDE.md (Workspace Detection, `updatePackageJson` integration point); README "Package managers and workspaces" (which manifest is written; catalog rows write the catalog; one JSON row per manifest) and Troubleshooting (`held with <path> (…)`); `pnpm run test:badges` and commit `badges/` if coverage moved.

**Real-run check (end of Phase 3)** — `"debug": true` to see commands; fresh copies per manager:
1. Default config `update --json`; compare manifests to originals; read installed versions (member first, then root). Every row's `updated`/`reason` matches disk. Expected: npm debug b 4.3.7 and ms root 2.1.3 updated, dayjs b per what npm installed (likely `not applied`, 1.11.9 deduped); pnpm specs rewritten by pnpm, root ms `not applied by pnpm (installed 2.1.2)`; yarn v1 b has debug 4.3.7 and its own dayjs 1.11.23, updated; bun members moved within range, root pin stays.
2. `{"beyondRange": "patch"}`: root `dayjs` `"1.11.23"` and `packages/a` `ms` `"2.1.3"` on disk and installed, reported updated. If root `npm update` ignores a member's rewritten spec, add `['install']` after the writes, before `update` (as pnpm), and record the evidence in the npm adapter comment.
3. Per manager, single-package `update --json` base vs new on fresh copies: identical stdout, package.json, lockfile.

## Design considerations

- All human text goes through `logger`; `--json` stays one document. `widths.workspace === 0` keeps single-package lines unchanged.
- npm, pnpm, bun keep one in-range manager run; yarn v1 adds one per affected member plus one `install` (required). Discovery stays one command (two for pnpm). Time `readWorkspace` on the largest workspace available and note it in the PR.
- Manager output formats stay in adapters; pipeline, fold and expansion know only `Discovery`, `OutdatedEntry`, `ManifestPlan`, so #79 (berry) can return `{ kind: 'workspace', entries }`.

## Risks

1. The together rule is conservative (could hold a row yarn's per-workspace command could move); only triggers on target-dependent holds; reason names the blocking manifest.
2. Peer pass runs before cooldown and the together rule; a later hold is not re-checked against peers (same caveat as today's cooldown); document in `src/utils/CLAUDE.md`.
3. pnpm merges rows with the same current across owners, so `--compatible` gives one `latest` for them; if two owners' ranges allow different maxima, one row's `wanted` may belong to another owner; the post-apply check reports any shortfall.
4. Unnamed roots/members (yarn, bun): fallback driven by the capture; anything else fails `discover` with a message naming the workspace.
5. Unsupported glob syntax in yarn/bun `workspaces` gives a clear `discover` failure; npm and pnpm attribute owners from paths.
6. Workspace `check --json` drops manager pass-through fields (agreed shape); call out in PR and CHANGELOG.
7. Single-package behavior: guarded by verbatim `!isWorkspace` branches, npm's identical commands (applyRanges, reuseDiscovery, stepFailures), pnpm readWorkspace parity cases, the Phase 1 snapshot, and per-phase real diffs. Any failure there is a bug, not a snapshot update.
8. Interactive targeting stays by package name.
