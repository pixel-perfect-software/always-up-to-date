# Package Managers - Component Context

## Purpose
One adapter per package manager (npm, yarn, pnpm, bun): everything specific to that manager. The pipeline in `src/pipeline.ts` runs detect → discover → plan → apply → report the same way for every adapter.

## Current Status: Stable
All four package managers are implemented with workspace support. Yarn berry has no discovery yet (#79).

## Component-Specific Development Guidelines
- An adapter is a plain object implementing `ManagerAdapter` (`adapter.ts`):
  - `name`, `lockfile`: what detection looks for
  - `readWorkspace(cwd)` → `{ isWorkspace, catalogs }`, read once per run and passed back to `discover` and `apply`
  - `discover(run, cwd, workspace)` → the manager's outdated report as `Record<string, PackageInfo>`. The output parser is an exported pure function (`parseNpmOutdated`, `parsePnpmOutdated`, `parseYarnOutdated`, `parseBunOutdated`) with direct tests on captured fixtures
  - `apply(run, cwd, plan, workspace)`: writes the specs the manager does not write itself, then runs its update commands. `plan` is `{ names, withinRange, beyondRange, discovered }`
  - `saveStyle(cwd)`: exact or prefix for specs that can't keep their shape, read from where the manager's current version keeps it
  - `overrides(cwd)`: packages pinned by an override field the manager enforces
- Adapters never log progress, group output, run the policy or catch failures: the pipeline does. `run` is bound to the step, so a failure is already a `StepError`
- Adding a manager: its adapter directory, its entry in `adapters` (`index.ts`) and `SupportedPackageManager`, and fixtures in `__tests__/fixtures/<pm>/`. Nothing else changes

## Major Subsystem Organization
```
managers/
  adapter.ts           # ManagerAdapter, Workspace, RunManager, ApplyPlan
  index.ts             # adapters registry (detection order), adapterFor(name)
  workspaces.ts        # readManifest(), hasWorkspacesField() shared by npm, yarn, bun
  npm/index.ts         # npm adapter, parseNpmOutdated
  yarn/index.ts        # yarn adapter, parseYarnOutdated, isYarnBerry
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
- Checks each adapter's `lockfile` in registry order: npm -> yarn -> pnpm -> bun
- Last match wins if multiple lock files exist (#78 changes this)

### Workspace Detection
| Manager | Method | Flag |
|---------|--------|------|
| npm | `package.json` `workspaces` field (array or `{packages: [...]}`) | `--workspaces` |
| yarn | `package.json` `workspaces` field | `--recursive` (on `outdated` only) |
| pnpm | `pnpm-workspace.yaml` with a non-empty `packages:` list (a file holding only settings or catalogs is not a workspace) | `-r` |
| bun | `package.json` `workspaces` field + optional `catalog`/`catalogs` | `--filter *` (two arguments) |

`catalogs` lists catalog names (pnpm: `catalog` and the keys of `catalogs:` in pnpm-workspace.yaml; bun: the same fields in package.json). The pipeline logs the workspace once per run, and the catalogs when it is a workspace.

## Integration Points
- `src/pipeline.ts`: `check(project)`, `plan(project, outdated, targets?)`, `update(project, { targetPackages?, discovered? })`, where a `Project` is `{ cwd, config, adapter }`. `openProject(cwd)` (`src/project.ts`) builds it with `adapterFor(detectPackageManager(cwd))` after loading the config
- `plan` runs `src/utils/filterPackages.ts` with `project.config` and `adapter.overrides(cwd)`
- `src/utils/files.ts` `updatePackageJson()` writes version updates before running the manager's update command (npm, pnpm, bun), only for packages moving past their range
- `src/utils/overrides.ts` (`overridesFromField`, `manifestOverrides`) and `src/utils/saveStyle.ts` (`readTextFile`, `yamlValue`) hold the generic readers adapters build on

### Discovery: names
Every parser's report goes through `toManifestNames()`, so results are keyed by the package.json name. An `npm:` alias (`"dj": "npm:dayjs@1.11.9"`) otherwise comes back as `dj:dayjs@1.11.9` (npm) or the target name `dayjs` (pnpm, bun); yarn v1 reports `dj` but with `exotic` as wanted and latest, which the policy holds as an invalid version. The managers' own `update dj` accepts the alias key.

### Discovery: `wanted`
Every parser fills `PackageInfo.wanted`, the highest version the manifest range allows: npm's `wanted`, yarn v1's `Wanted` column, bun's `Update` column. pnpm's own `wanted` is the lockfile's version, so pnpm also runs `outdated --compatible` (in parallel) and takes `wanted` from its `latest`.

### Apply: within range vs beyond range
- In-range updates (`target == wanted`) go to the manager by name with no manifest write: `npm update`, `pnpm update`, `bun update`, yarn `upgrade name@<current spec>`. Each manager installs `wanted`; npm and yarn leave package.json alone, pnpm and bun raise the range floor (their own convention)
- Beyond-range updates get their spec rewritten to the target first (decorator kept), then the same command
- pnpm workspaces, and single-package projects with `catalog:` / `catalogs:` in pnpm-workspace.yaml, run `install` after manifest/catalog writes, then `update <in-range names>` (`-r` only in a workspace); bun catalogs the same with `install` then `update <names> --filter *`

### Yarn apply (`src/managers/yarn/index.ts`)
- yarn writes the manifest itself: autd passes `name@spec` descriptors from `buildUpdateDescriptors()` and never pre-writes `package.json` (v1 then fails with "Outdated lockfile")
- v1 runs `yarn upgrade <descriptors>`, berry runs `yarn up <descriptors>`; neither has `update`. No `--recursive` on apply: v1 has no such flag and berry's rejects explicit ranges
- A bare `yarn up name` on berry rewrites an exact pin to `^`, so descriptors always carry the spec
- `isYarnBerry(cwd)` (exported here; also decides save style and overrides): `packageManager: yarn@2+` wins; otherwise a `.yarnrc.yml` means berry
- Packages missing from the root manifest are skipped with a warning: v1 `upgrade` at a workspace root adds them as root dependencies
- Berry has no `outdated`, so discovery (and therefore `check`/`update`) does not run on berry yet (#79)
