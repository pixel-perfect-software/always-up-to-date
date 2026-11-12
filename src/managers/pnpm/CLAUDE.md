# pnpm adapter

## Overview

What is specific to pnpm 12: its `.npmrc` view (env, yaml routes, ini files and a global directory, in its own order), `pnpm-workspace.yaml` as the one source for packages, catalogs, overrides, save style, `nodeVersion`, registries, fetch settings and the release-age gate, and its apply. The shared contract is in `src/managers/CLAUDE.md`; the registry machinery in `src/utils/REGISTRY.md`.

## Key Files

| Path               | Role                                                                                                                                                                                                                                                                                           |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`         | The adapter; re-exports `pnpmWorkspaceRoot`                                                                                                                                                                                                                                                    |
| `workspaceYaml.ts` | The one pnpm yaml reader (#229): `parsePnpmYaml()` (`parseYaml` with `flowMaps` and `anchors`), `readPnpmYaml(file)`, `readPnpmWorkspaceYaml(dir)`, and each consumer's part: `pnpmPackages`, `pnpmCatalogs`, `pnpmOverrides`, `pnpmSetting` (a top-level string). Imports only `@/utils/yaml` |
| `npmrc.ts`         | `pnpmNpmrcLayers()`, `PNPM_ENV`, `pnpmConfigDir()`: pnpm 12's `.npmrc` layers                                                                                                                                                                                                                  |
| `registries.ts`    | `pnpmRegistrySettings(yaml \| PnpmYaml, { env }?)`, `substitutePnpm()`: registry routes from a pnpm yaml file's text or parsed document                                                                                                                                                        |
| `releaseAge.ts`    | `pnpmReleaseAgeGate()`: `minimumReleaseAge` and its excludes (#168)                                                                                                                                                                                                                            |

## `pnpm-workspace.yaml`

- Every pnpm reader of `pnpm-workspace.yaml` and the global `config.yaml` (packages, catalogs, overrides, `saveExact` / `savePrefix`, `nodeVersion`, registries, `fetchTimeout` / `fetchRetries`, the release-age gate) takes its part from `workspaceYaml.ts` (#229), so one file is never read two ways. Each consumer still reads the file itself: no per-run cache, since one keyed by path and mtime could serve a stale document after a same-size rewrite within one mtime tick (the catalog writer rewrites the file mid-run), and passing one document down from `openProject` would reshape the adapter hooks
- pnpm's reading turns on `parseYaml`'s `flowMaps` (a flat one-line flow map) and `anchors` (an anchored value); berry's leaves both off
- Workspace: a non-empty `packages:` list (a file holding only settings or catalogs is not a workspace)
- `projectRoot`: the nearest `pnpm-workspace.yaml`'s directory when it is `dir` or its `packages` list `dir` (`pnpmWorkspaceRoot` in `src/managers/workspaces.ts`, which `locate` shares), never a farther one; a member with its own yaml, or under a nearer yaml that does not list it, is its own project
- Catalogs: `pnpmCatalogs` over the parsed file (#229), a flow-map catalog included; `default` for `catalog:`. The writer (`updatePNPMWorkspaceYAML`, `src/utils/MANIFESTS.md`) keeps its line walk, which rewrites the same entries the reader reads: block entries, a flat one-line flow map (`catalog: { ms: ^2.1.1 }`, a named catalog `tools: { … }`), an anchored catalog, and a file behind a byte order mark (#230)
- Overrides: `overrides` in pnpm-workspace.yaml (pnpm 12 ignores `pnpm.overrides` / `resolutions` in package.json). Save style: `saveExact` / `savePrefix` there (not `.npmrc`)
- `nodeVersion?(cwd)`: a valid semver `nodeVersion` in the project's `pnpm-workspace.yaml` (#199), the Node pnpm judges `engines` by; `plan` passes it with the label `pnpm nodeVersion`

## `.npmrc` view (verified on pnpm 12.15.0 and 12.14.0, 2026-10-26, 111 probe rows that agree; #117, probes p20-p55)

Layers, highest first, each key from the first that sets it, with no `registryConfig` hook (each yaml file parsed once by `parsePnpmYaml`, its routes taken by `registries.ts`):

1. `pnpm_config_*` env: `pnpm_config_<lower_snake>` or `PNPM_CONFIG_<UPPER_SNAKE>`, nothing mixed; `_` becomes `-`, camelCase isn't read; `//` keys are kept as written and read under a prefix in any case (`Pnpm_Config_//…` too); `@scope:registry` is not read from the environment; values expand `${VAR}` and `${VAR:-default}`. With both casings of a key set, `PNPM_CONFIG_*` wins whatever the environment's order; two `//` credentials tie and the later in the environment wins (pnpm's own order dependence)
2. `npm_config_*` / `NPM_CONFIG_*`, `//host/:…` credential keys only, in any case of the prefix (`Npm_Config_//…` is read), values not expanded. Every other `npm_config_*` key, routes included, is ignored. A `${…}` value there is sent literally by pnpm; autd sends no credential (it never sends a credential holding `${…}`)
3. the project `pnpm-workspace.yaml` routes (`registry`, `registries` as a block or flat one-line flow; top-level `registry` beats a `registries` default; a `${…}` value is ignored and a lower layer decides)
4. the global `config.yaml` routes, no credentials; `${…}` expands
5. the project `.npmrc`; an entry holding `${…}` in its key or value is left out, so a lower layer decides
6. the global `auth.ini`, expanded
7. the user file: `pnpm_config_userconfig`, else `PNPM_CONFIG_USERCONFIG`, else `npm_config_userconfig`, else `NPM_CONFIG_USERCONFIG` (the lower-case name wins whatever the environment's order, mixed case isn't read), else `~/.npmrc`. The path is used raw: relative to cwd, with neither `${VAR}` nor `~` expanded; a missing file means no user layer

- So the project files never expand `${…}`; the user and global files expand with pnpm's rule: `${VAR}` and `${VAR:-default}` in keys and values; an unset `${VAR}` becomes `''` and shadows lower layers. For a token pnpm then sends `Authorization: Bearer ` with nothing after it; autd's lookup skips an emptied credential and falls back to a shorter same-host prefix's token, as it does for an empty token under npm, or sends none when there is no such prefix (both fail auth, and nothing leaves the host). Routes follow the credentials of their host from any layer
- The global directory is `$XDG_CONFIG_HOME/pnpm` (a relative one against cwd, no fallback), else `~/Library/Preferences/pnpm` on macOS (`~/.config/pnpm` isn't read there), else `~/.config/pnpm`. On Windows without XDG it is `%LOCALAPPDATA%\pnpm\config`. Linux was run in Docker (node:24, pnpm 12.15.0): `~/.config/pnpm/auth.ini` and `config.yaml` are read, `~/Library/Preferences/pnpm` and `rc` are not, and an XDG directory beats `~/.config/pnpm`. Windows comes from pnpm's source at v12.15.0 (`getConfigDir`), not a run; autd does not expand `%VAR%` in a Windows path. The legacy `rc` file and npm's `<prefix>/etc/npmrc` are not read
- From a workspace member, the project files are the nearest ancestor `pnpm-workspace.yaml`'s directory's (the root; a member's own `.npmrc` is ignored, a member with its own yaml is its own root)
- Fetch settings: pnpm 12 reads `fetchTimeout` / `fetchRetries` from the project `pnpm-workspace.yaml`, then the global `config.yaml`, under `pnpm_config_fetch_timeout` / `pnpm_config_fetch_retries`. Its yaml layers carry them as `fetch-timeout` / `fetch-retries`, and its ini layers (project `.npmrc`, `auth.ini`, user file) drop both keys in either spelling (`iniLayer`, `npmrc.ts`): pnpm ignores them in every ini file. Verified on pnpm 12.14.0, 2026-10-27 (#125)
- Unusable values: pnpm skips a `${…}` in a project file (`.npmrc`, `pnpm-workspace.yaml`) and falls through, and autd skips it too; a `${VAR}` that pnpm's global files expand to nothing is an empty value, which pnpm fails on. `emptyRegistry`: pnpm fails on an empty default and an empty scope
- Not read: a nested flow `registries` in pnpm's yaml, pnpm's Windows `%VAR%` expansion in its config directory

## Release-age gate (#168, probes p01-p19)

`pnpmReleaseAgeGate`: `minimumReleaseAge` in minutes from `pnpm_config_minimum_release_age`, then `pnpm-workspace.yaml`, then the global `config.yaml`, one day unless set (an empty key, null or blank, is unset, #247; 0 is off); `minimumReleaseAgeExclude` names and globs (`*` crossing `/`) with optional exact versions; a missing time allowed unless `minimumReleaseAgeIgnoreMissingTime: false` (which also never takes the `modified` shortcut, #177). Cases in `__tests__/releaseAgeGates.test.ts`.

## Engines

pnpm 12.18.0 judges engines by `nodeVersion` when set, else the running Node, and installs the highest satisfying version whatever the engines (probed 2026-11-07), so it has no `skipsEnginesExcluded`.

## Apply

- In-range updates go to `pnpm update` by name with no manifest write; pnpm installs `wanted` and raises the range floor (its own convention), catalog ranges included
- A workspace writes catalog rows to pnpm-workspace.yaml and the rest to their own package.json (`writeBeyondRange`, `src/managers/beyondRange.ts`), runs `install --no-frozen-lockfile` if anything was written, then `update -r <in-range names>`. A single-package project with catalogs takes the same path with its one manifest, and runs `update <in-range names>` without `-r`. `--no-frozen-lockfile` because with `CI` set pnpm makes a plain `install` frozen and refuses the lockfile the rewrite made stale (#98)
- pnpm may leave a row where it was: it keeps root `ms` at its lockfile version. In a workspace or with catalogs it dedupes the root's `ms` (`~2.1.1`) onto 2.1.2, which a member pins: `pnpm update -r ms` writes `~2.1.2`, and autd reports the row `not applied by pnpm (installed 2.1.2)` (an integration-matrix override)
- Cooldown fallbacks: pnpm 12.14.0 keeps the locked version when the range comes back; `pinning` has `writeCatalog`, and the restored range is the one written, so pnpm doesn't raise its floor as its `update` would
- Installed peers: `readInstalledPeers` reads the pnpm store entries `.pnpm/lock.yaml` lists; an orphan it no longer lists is skipped (#146)
- Frozen install in the integration matrix: `pnpm install --frozen-lockfile`
