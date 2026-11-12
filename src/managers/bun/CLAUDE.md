# bun adapter

## Overview

What is specific to bun 1.4: its `.npmrc` layers (the project file and one user file), `bunfig.toml` routes and credentials and the registry and token variables over them, catalogs in package.json, its release-age gate, and its apply. The shared contract is in `src/managers/CLAUDE.md`; the registry machinery in `src/utils/REGISTRY.md`.

## Key Files

| Path        | Role                                                                                                                                                 |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`  | The adapter                                                                                                                                          |
| `npmrc.ts`  | `bunNpmrcLayers()`, `bunUserNpmrc()`, `substituteBun()`: bun's `.npmrc` layers (project, one user file)                                              |
| `bunfig.ts` | `bunfigExact()`, `parseBunfigRegistries()`, `bunRegistryConfig()`, `bunReleaseAgeGate()`: registry routes, credentials and the gate from bunfig.toml |

## `.npmrc` layers (verified on bun 1.4.4, 2026-10-26, `bun install --lockfile-only`)

- The project `.npmrc` (the workspace root's from a member, b33: no parent's) over one user file, chosen as `NPM_CONFIG_USERCONFIG`, else `npm_config_userconfig` (upper case wins; cwd-relative, `~/` expanded; replaces both files below; a missing file is no user layer), else `$XDG_CONFIG_HOME/.npmrc` if any entry exists (an empty file or a directory hides `~/.npmrc`; a relative XDG is not used, an absolute XDG only), else `~/.npmrc`. A dangling symlink at `$XDG_CONFIG_HOME/.npmrc` is not an entry (bun reads `~/.npmrc`); a directory or an empty file is
- No `npm_config_*` route or credential is read (b26, b27), nor `<prefix>/etc/npmrc` or npm's builtin (b32). The env token beats an `.npmrc` token on an `.npmrc` route (b28, b29), already so in `bunRegistryConfig`
- Values only are expanded, never keys, after the shared parser (so booleans stay booleans, and an expanded value is never expanded again). `${VAR}` expands anywhere (`${VAR?}` is '' when unset), `$VAR` only when the parsed value as a whole is `$NAME` (`pre$TOK` and `host:$PORT` stay literal); an odd run of backslashes before a `$` escapes it. An unset variable stays literal. bun sends a literal `${UNSET}` token as `Bearer ${UNSET}`, and it shadows a lower layer's token; autd's rule is that a credential still holding `${…}` is absent, so it sends none there (a `$UNSET` literal is sent as bun does)
- Differences from bun: the parser has already collapsed each `\\` pair, so two backslashes before `${T}` read as one (autd sends the literal where bun sends `\VAL`), and a line holding U+2028 or U+2029 is dropped by the parser's `.` (bun keeps it)
- `save-exact` is read from bun's own layers (bun reads it from the project and user `.npmrc`, not from `npm_config_save_exact`); save style is `bunfig.toml` `[install] exact` or `.npmrc` `save-exact` (no prefix setting)
- Not verified: bun on Windows probably takes its home from `USERPROFILE`; autd uses `HOME` / `os.homedir()`

## Registries (`bunfig.ts`, through the adapter's `registryConfig` hook)

- Default registry `BUN_CONFIG_REGISTRY` > `NPM_CONFIG_REGISTRY` > project bunfig > global bunfig (`$XDG_CONFIG_HOME/.bunfig.toml` or `~/.bunfig.toml`) > `.npmrc`; scopes project bunfig > global bunfig > `.npmrc`; credentials inline (`token`, `username` + `password`, URL userinfo) > `BUN_CONFIG_TOKEN` / `NPM_CONFIG_TOKEN` (default registry only, never a public npm registry) > the `.npmrc` entry
- From a workspace member, bunfig.toml and `.npmrc` are the workspace root's (`package.json` `workspaces`; the member's own are ignored)
- Forms: `[install] registry`, `[install.scopes]` string or inline table, and `[install.scopes.<name>]` subtables (`url`, `token`, `username`, `password`); username-only URL userinfo (`http://TOKEN@host/`) is Basic `TOKEN:`; `$NAME` expands in `token`, `username` and `password`
- A scope's inline credential is stored per URL prefix, as an `.npmrc` `//host/:_authToken` is, so it covers the whole prefix although bun sends it only for that scope (same host, so nothing crosses hosts); when it shares a prefix with the default route's credential, the default's wins and a debug line says so
- `emptyRegistry`: bun skips an empty default and an empty scope
- Not read in bunfig.toml: dotted keys (`scopes.acme = …`) and `scopes = { … }`

## Release-age gate (#168, probes b01-b11)

`bunReleaseAgeGate`: `[install] minimumReleaseAge` in seconds from the project bunfig.toml, else the global one, off unless set; `minimumReleaseAgeExcludes` exact names with an optional version. A version with no publish time is let through (`missingTime: 'allowed'`). Cases in `__tests__/releaseAgeGates.test.ts`.

## Workspace and catalogs

- Workspace: `package.json` `workspaces` field, plus optional `catalog` / `catalogs` (top level or under `workspaces`)
- bun reads `workspaces.catalog` / `workspaces.catalogs` as well as the top-level fields; when the `workspaces` one is set it replaces the top-level one as a whole, per field (verified on bun 1.4.4). `readBunCatalogs` and `updateBunCatalogs(cwd, versions, style, catalog?)` follow that
- Overrides: `overrides` and `resolutions`

## Engines

bun 1.4.4 ignores engines and installs the highest satisfying version (probed 2026-11-07). Under a Bun runtime (`runningNode()` null) with nothing declared, the engines pass skips the row with one debug line.

## Apply

- In-range updates go to `bun update` by name with no manifest write; bun installs `wanted` and raises the range floor (its own convention). bun 1.4.0 raises floors in package.json but leaves `catalog`/`catalogs` ranges as written
- A workspace without catalogs writes each manifest, then `update <names> --filter *`. With catalogs it writes catalog entries (`updateBunCatalogs`) and the rest per manifest (`writeBeyondRange`, `src/managers/beyondRange.ts`), runs `install` if anything was written, then `update <in-range names> --filter *`. A single-package project always takes the plain path. bun doesn't freeze `install` under `CI`
- Cooldown fallbacks: bun 1.4.4 keeps the locked version when the range comes back; `pinning` has `writeCatalog`, and the restored range is the one written, so bun doesn't raise its floor as its `update` would
- The integration matrix caught bun catalog rows (`catalog (<ws>)`) failing discovery, an autd bug. Frozen install there: `bun install --frozen-lockfile`
