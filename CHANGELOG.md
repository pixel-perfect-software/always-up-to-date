# Changelog

Notable changes to `@pixel-perfect-software/always-up-to-date`, newest first. Versions before
2.0.0 were published without a changelog.

## 2026-10-27 — 3.1.0: one report that names every hold, and a cooldown that fresh releases can't slip past

`check`, `update --dry-run` and `update` print one report. Every outdated package appears once, under what happened to it and why: held by a rule, past its range and the `beyondRange` level that would move it, held by cooldown, or left in place by the package manager. Before, a package held by a rule or by its range showed up only in the first list, and others were printed twice. Cooldown now holds a version whose publish date it can't find, instead of letting it through. `--json` output is unchanged.

### Changed
- One report for `check`, `update --dry-run`, interactive mode and `update`, grouped by outcome ([#138](https://github.com/pixel-perfect-software/always-up-to-date/issues/138)):
  - **Outcomes:** would update or updated (within or past its range), left in place by the manager, held by cooldown, past the range in package.json (naming the `beyondRange` level that would move it), held by a rule, an override, a peer conflict, or with another manifest.
  - **Workspace rows:** one row per package and move. One or two manifests are listed by path, and three or more are counted.
  - **Summary:** one line at the end counts each outcome.
  - **`update`** prints the report once, after the package manager has run, with what it installed.
  - **Removed:** the grouping by `@scope`, and the `[ignored]` / `[allowed]` tags of the deprecated allow and deny lists, which are rules now.
- A pnpm project whose `pnpm-workspace.yaml` lists only `"."` no longer prints a workspace line or `(root)` on every row. A real workspace prints its manifest and catalog counts, and the catalog names moved to `debug` ([#138](https://github.com/pixel-perfect-software/always-up-to-date/issues/138)).

### Fixed
- Cooldown takes a version's publish date from deps.dev when the registry document lacks it, and holds a version whose date is still unknown as `cooldown: release date unknown`. Before, a proxy or mirror that lags behind the registry hid the freshest releases from cooldown, and those went straight through ([#139](https://github.com/pixel-perfect-software/always-up-to-date/issues/139)). On 2026-10-27, motion 14.7.1, 4 hours old, passed a 2-day cooldown.
- In pnpm projects, `fetchTimeout` and `fetchRetries` are read from `pnpm-workspace.yaml`, the global `config.yaml` and `pnpm_config_*`, as pnpm 12 reads them. They're ignored in `.npmrc`, `auth.ini` and `~/.npmrc`, where pnpm ignores them too ([#125](https://github.com/pixel-perfect-software/always-up-to-date/issues/125)).

### Known issues
- yarn 2+ still runs the manager to find outdated packages ([#107](https://github.com/pixel-perfect-software/always-up-to-date/issues/107)). With PnP, installed peer ranges aren't read, so no update is held for a peer conflict.
- Run from inside a workspace member, autd finds no package manager ([#123](https://github.com/pixel-perfect-software/always-up-to-date/issues/123)).
- yarn v1's `always-auth`, its bare `_authToken`, and a member's own `.npmrc` during its upgrade are still read differently from yarn ([#126](https://github.com/pixel-perfect-software/always-up-to-date/issues/126), [#127](https://github.com/pixel-perfect-software/always-up-to-date/issues/127)).
- Cooldown still reads full registry documents for its dates, uncached ([#47](https://github.com/pixel-perfect-software/always-up-to-date/issues/47)).

## 2026-10-27 — 3.0.0: outdated packages found without the package manager, a registry cache, and each manager's own registry settings

**Breaking:** `check` no longer runs the package manager's `outdated` for npm, pnpm, yarn v1 and bun. It reads the manifests, `node_modules` and the registry itself. As a result:
- `check --json` loses the manager-specific fields;
- peer-only dependencies are no longer listed;
- a failed lookup fails the run;
- a project with nothing installed must be installed first.

A repeated `check` within 5 minutes makes no request at all. On the 40-dependency benchmark, it takes 0.10 s and about 85 MB on every manager, against 0.74–2.70 s and 116–819 MB in 2.2.0. Registries and credentials are now read from the files each manager reads, for lookups and cooldown alike. By default, the names of packages served by registry.npmjs.org are looked up at deps.dev; `depsDev: false` turns that off.

### Breaking
- `check --json` no longer passes through npm's `dependent` and `location` or pnpm's `isDeprecated` and `dependencyType` ([#106](https://github.com/pixel-perfect-software/always-up-to-date/issues/106)).
- A dependency declared only in `peerDependencies` is no longer listed. npm and bun used to list one; pnpm and yarn did not ([#106](https://github.com/pixel-perfect-software/always-up-to-date/issues/106)).
- A failed registry lookup fails `check` with exit code 1, naming each package and its reason ([#106](https://github.com/pixel-perfect-software/always-up-to-date/issues/106)).
- With no `node_modules`, `check` stops with "Nothing is installed in … (no node_modules): run `<pm> install`, then check again." npm projects used to be read from `package-lock.json` (#91). Reading lockfiles returns in [#107](https://github.com/pixel-perfect-software/always-up-to-date/issues/107).

### Added
- Repeat registry lookups are answered from a disk cache, for as long as each registry says its answer stays good ([#108](https://github.com/pixel-perfect-software/always-up-to-date/issues/108)):
  - **Location:** `ca.pixel-perfect.alwaysuptodate` under `~/Library/Caches`, `$XDG_CACHE_HOME` or `~/.cache`, or `%LOCALAPPDATA%`; `AUTD_CACHE_DIR` moves it.
  - **Contents:** only the versions, their deprecation and publish dates, and `latest`; no registry document, header or credential. It's capped at 32 MiB, and deleting it is always safe.
  - **Turning it off:** `--no-cache` on `check` and `update`, or `AUTD_NO_CACHE`, reads and writes nothing.
- `depsDev` in `.always-up-to-date.json`, default `true` ([#105](https://github.com/pixel-perfect-software/always-up-to-date/issues/105)):
  - **What is sent:** packages served by registry.npmjs.org or registry.yarnpkg.com are looked up at api.deps.dev, about 8 KB each instead of a registry document that can run to megabytes. Their names are sent there, private packages published to registry.npmjs.org included.
  - **What is never sent:** names from any other registry, and any credential.
  - **Turning it off:** `false` reads everything from the registry. The value must be a real boolean; `"false"` is an error.

### Changed
- `check` doesn't need the package manager on `PATH`, except for yarn 2+ ([#106](https://github.com/pixel-perfect-software/always-up-to-date/issues/106)).
- `wanted` follows one rule for every manager, per manifest. The highest version the range allows wins, and deprecated versions are passed over unless nothing else fits; yarn v1 used to pick deprecated ones ([#106](https://github.com/pixel-perfect-software/always-up-to-date/issues/106)).
- Lists are sorted by name for every manager ([#106](https://github.com/pixel-perfect-software/always-up-to-date/issues/106)).
- Registries and credentials come from each manager's own files and order, for lookups and cooldown alike:
  - pnpm 12 reads `pnpm_config_*`, `pnpm-workspace.yaml`, its global `config.yaml`, the project `.npmrc`, its global `auth.ini`, then `~/.npmrc`. Of `npm_config_*`, only `//` credentials count, and a `${…}` in a project file is ignored ([#117](https://github.com/pixel-perfect-software/always-up-to-date/issues/117)).
  - bun 1.4 reads `bunfig.toml`, `BUN_CONFIG_REGISTRY` and `BUN_CONFIG_TOKEN`, the project `.npmrc`, then one user file: `$XDG_CONFIG_HOME/.npmrc` when it exists, else `~/.npmrc`. npm's global npmrc, and `npm_config_*` beyond the registry, token and user file, are no longer read ([#118](https://github.com/pixel-perfect-software/always-up-to-date/issues/118)).
  - yarn v1 reads `.yarnrc` registry routes, a member's own `.npmrc`, and the `.npmrc` of each parent directory ([#120](https://github.com/pixel-perfect-software/always-up-to-date/issues/120), [#122](https://github.com/pixel-perfect-software/always-up-to-date/issues/122)).
  - From a workspace member, pnpm and bun read the workspace root's settings files ([#119](https://github.com/pixel-perfect-software/always-up-to-date/pull/119)).

### Fixed
- In a pnpm workspace, members that share an installed version get their own rows, each with its own in-range maximum. They used to be merged into one row ([#95](https://github.com/pixel-perfect-software/always-up-to-date/issues/95)).
- A registry URL the package manager can't use now fails `check`, naming the file, the setting and the reason. Examples are a URL that doesn't parse, a non-http(s) one, or one with an unset variable. Before, autd fell back to registry.npmjs.org and sent it the names of privately routed packages ([#129](https://github.com/pixel-perfect-software/always-up-to-date/issues/129)).
- A token in a registry URL's path is no longer printed ([#131](https://github.com/pixel-perfect-software/always-up-to-date/issues/131)). Gemfury puts tokens there. This covers errors, debug lines, `--json` error objects, and the manager's own output as autd reports it.
- yarn v1 `npm:` alias rows show the target package's real versions ([#106](https://github.com/pixel-perfect-software/always-up-to-date/issues/106)).
- Moving a pnpm or bun catalog entry no longer moves the same package in other catalogs. A range like `>=18.0.0 <19` is no longer rewritten as `^19.0.0 <19` ([#121](https://github.com/pixel-perfect-software/always-up-to-date/pull/121)).

### Known issues
- yarn 2+ still runs the manager to find outdated packages ([#107](https://github.com/pixel-perfect-software/always-up-to-date/issues/107)). With PnP, installed peer ranges aren't read, so no update is held for a peer conflict. `yarn up -R` also moves transitive copies of the updated packages within their ranges.
- Run from inside a workspace member, autd finds no package manager ([#123](https://github.com/pixel-perfect-software/always-up-to-date/issues/123)).
- A few registry settings are still read differently from the manager:
  - pnpm's `fetchTimeout` and `fetchRetries` ([#125](https://github.com/pixel-perfect-software/always-up-to-date/issues/125));
  - yarn v1's `always-auth` and bare `_authToken` ([#126](https://github.com/pixel-perfect-software/always-up-to-date/issues/126));
  - a yarn v1 member's own `.npmrc` during its upgrade ([#127](https://github.com/pixel-perfect-software/always-up-to-date/issues/127)).
- Cooldown still reads full registry documents, uncached ([#47](https://github.com/pixel-perfect-software/always-up-to-date/issues/47)).

## 2026-10-26 — 2.2.0: cooldown reads `.npmrc` the way npm does, Node 22 support, and faster startup

Cooldown's registry lookups now go through autd's own client, which reads `.npmrc` the way npm 12 does. A scoped package is looked up on its own registry with its own credentials, and custom CAs, `strict-ssl` and proxies apply. The supported Node range is now `^22.23.0 || >=24.17.0`: Node 22 works, and Node 24 needs 24.17 or later. Every command starts about 50 ms sooner, since the registry client loads only when cooldown needs it.

### Added
- Cooldown lookups honor the rest of npm's registry settings ([#46](https://github.com/pixel-perfect-software/always-up-to-date/issues/46)):
  - auth per registry: `_authToken`, `_auth`, `username` and `_password`, and client certificates through `certfile` and `keyfile`;
  - proxies: `https-proxy`, `proxy` and `noproxy`, as well as `HTTPS_PROXY` and `NO_PROXY`;
  - `fetch-retries`, `fetch-timeout` and `maxsockets`.

### Changed
- The supported Node range is `^22.23.0 || >=24.17.0`, from `>=24.0.0`. Node 22.23 and later now work, and Node 24.0 to 24.16 fall outside the range ([#46](https://github.com/pixel-perfect-software/always-up-to-date/issues/46)).
- `.npmrc` is read the way npm 12 reads it ([#46](https://github.com/pixel-perfect-software/always-up-to-date/issues/46)). This also changes where npm and bun projects take `save-exact` and `save-prefix` from:
  - the global npmrc and lower-case `npm_config_*` variables now count;
  - in a workspace member, the workspace root's `.npmrc` applies;
  - an unset `${VAR}` stays as written, where it used to become empty.
- `autd --version` takes 68 ms instead of 118 ms ([#46](https://github.com/pixel-perfect-software/always-up-to-date/issues/46)).
- SOCKS proxies are no longer used for cooldown lookups; use an HTTP or HTTPS proxy ([#46](https://github.com/pixel-perfect-software/always-up-to-date/issues/46)).

### Fixed
- Cooldown now follows `.npmrc` for every package ([#104](https://github.com/pixel-perfect-software/always-up-to-date/issues/104)):
  - A scoped package's release dates come from its own registry, with that registry's token. Before, a private scoped package was looked up on registry.npmjs.org, and its update went through with no cooldown.
  - `strict-ssl`, `cafile` and `ca[]` take effect. Before, behind a custom CA, cooldown never found a release date.
  - Lookups are retried after a 429, a 5xx or a dropped connection. Before, a single failed request let the update through with no cooldown.

### Known issues
- pnpm merges workspace members that share an installed version into one row, so a member can be shown another member's in-range maximum ([#95](https://github.com/pixel-perfect-software/always-up-to-date/issues/95)).
- On yarn 2+ with PnP, installed peer ranges aren't read, so no update is held for a peer conflict. `yarn up -R` also moves transitive copies of the updated packages within their ranges.
- npm lists only the root's dependencies in a workspace that has no node_modules yet; run `npm install` first.

## 2026-10-23 — 2.1.0: workspaces updated per manifest, yarn 2+ support, and the package manager taken from package.json or `--pm`

Workspaces now work package by package: each dependency is found, planned, written and checked in the manifest that declares it, the root included. yarn 2+ (berry) runs for the first time, and autd uses the package manager your package.json declares before guessing from lockfiles. Nothing changes for single-package projects: their `--json` output is the same byte for byte. In workspace projects, `--json` gains fields.

### Added
- `check` and `update` take `--pm <npm|pnpm|yarn|bun>`. Without it, autd uses package.json's `packageManager`, then `devEngines.packageManager`, then the lockfile. A leftover lockfile from another manager is ignored, and a warning names the choice when several lockfiles exist and none is declared ([#78](https://github.com/pixel-perfect-software/always-up-to-date/issues/78)).
- yarn 2+ (berry) is supported, with PnP and with `nodeLinker: node-modules`. It reports and applies the same updates as yarn v1 on the same dependencies ([#79](https://github.com/pixel-perfect-software/always-up-to-date/issues/79)).
- In workspace projects, each value in `check --json` gains `workspaces: [{ path, current, wanted }]`, one row per manifest that declares the package. Each `update --json` row gains `workspace`. Human output shows `(root)` or the member path ([#59](https://github.com/pixel-perfect-software/always-up-to-date/issues/59)).
- Windows is tested: CI runs the suite and real npm, pnpm, yarn and bun updates on windows-latest ([#54](https://github.com/pixel-perfect-software/always-up-to-date/issues/54)).

### Changed
- `update` reports a package the package manager left in place as `updated: false`, with the reason `not applied by <manager> (installed <version>)`, instead of reporting a move that didn't happen ([#76](https://github.com/pixel-perfect-software/always-up-to-date/issues/76)).
- In a workspace, a package moves in every manifest or in none. If one manifest's row is held by a cooldown, a peer conflict or an override while its range allows newer, the other rows are held too, with the reason `held with <path> (…)` ([#59](https://github.com/pixel-perfect-software/always-up-to-date/issues/59)).
- A malformed `.always-up-to-date.json` fails only `check` and `update`, reported like any other failure. With `--json`, that is an `{ "error": … }` object on stdout. `--help`, `--version` and `init` no longer read the config ([#45](https://github.com/pixel-perfect-software/always-up-to-date/issues/45)).

### Fixed
- Workspace member dependencies are written to their own package.json when they move past their range, instead of being reported as updated while the manifest stayed the same ([#59](https://github.com/pixel-perfect-software/always-up-to-date/issues/59)). Related fixes:
  - npm workspaces no longer skip the root's own dependencies.
  - yarn v1 updates member-only packages instead of skipping them, and keeps devDependencies in `devDependencies`.
- Workspace discovery no longer loses rows: yarn v1 and bun used to overwrite one manifest's row with another's, and pnpm used to pass `ms@2.1.1` as a package name ([#59](https://github.com/pixel-perfect-software/always-up-to-date/issues/59)).
- `check` no longer crashes on an npm project that has a lockfile but no node_modules (a fresh clone); `current` is read from package-lock.json ([#91](https://github.com/pixel-perfect-software/always-up-to-date/issues/91)).
- Moving a pnpm catalog entry leaves `overrides` and `peerDependencyRules` alone. It also keeps the entry's quotes and trailing comment, and a commented entry now moves at all ([#80](https://github.com/pixel-perfect-software/always-up-to-date/issues/80)).
- `update` on CI no longer fails for pnpm workspaces and catalogs. pnpm makes a plain `install` frozen when `CI` is set, so it refused the lockfile autd had just rewritten ([#98](https://github.com/pixel-perfect-software/always-up-to-date/issues/98)).

### Known issues
- pnpm merges workspace members that share an installed version into one row, so a member can be shown another member's in-range maximum ([#95](https://github.com/pixel-perfect-software/always-up-to-date/issues/95)).
- On yarn 2+ with PnP, installed peer ranges aren't read, so no update is held for a peer conflict. `yarn up -R` also moves transitive copies of the updated packages within their ranges.
- npm lists only the root's dependencies in a workspace that has no node_modules yet; run `npm install` first.

## 2026-10-23 — 2.0.0: updates follow your package.json ranges, exact pins stay put, and the config can widen that per package

**Breaking:** with no config, `autd update` now applies what the package manager itself would: each dependency moves to the highest version its package.json range allows, and an exact pin stays where it is. 1.x went further on patches, moving any dependency with a newer patch release (pins included, rewritten to `^`), and stopped short on minors, holding minor updates even when the range allowed them. To let pins take patch releases again, set `"beyondRange": "patch"`. Existing configs keep working.

### Breaking
- The default update policy stays within each package.json range, the same set `npm update` applies, and holds exact pins ([#43](https://github.com/pixel-perfect-software/always-up-to-date/issues/43)).

### Added
- `.always-up-to-date.json` takes `beyondRange` (`"none"`, `"patch"`, `"minor"`, `"major"`), how far past its range a dependency may move. It also takes per-package `rules` (`"hold"`, `"followRange"`, `"latest"`), by exact name or `*` glob. `autd init` writes the new shape. `allowMinorUpdates`, `allowMajorUpdates`, `updateAllowlist` and `updateDenylist` still work as deprecated aliases ([#62](https://github.com/pixel-perfect-software/always-up-to-date/issues/62)).
- A package pinned by an override the package manager enforces is held and reported as `controlled by …`, instead of being moved to a version the manager won't install. That covers npm `overrides`, yarn berry `resolutions`, pnpm `overrides` in pnpm-workspace.yaml, and bun `overrides` / `resolutions` ([#63](https://github.com/pixel-perfect-software/always-up-to-date/issues/63)).
- An update that an installed package's peer range rejects is held and reported as `peer conflict: …`; a `latest` rule still moves it, with a warning ([#64](https://github.com/pixel-perfect-software/always-up-to-date/issues/64)).

### Changed
- Interactive update runs the package manager's `outdated` once instead of twice ([#39](https://github.com/pixel-perfect-software/always-up-to-date/issues/39)).

### Fixed
- Exact pins stay exact: 1.x rewrote `"18.2.0"` to `"^18.2.1"` on update ([#35](https://github.com/pixel-perfect-software/always-up-to-date/issues/35)).
- `check` works on yarn v1 under Node 24, where yarn prints a deprecation warning to stderr ([#36](https://github.com/pixel-perfect-software/always-up-to-date/issues/36)).
- yarn updates run `yarn upgrade` on v1 and `yarn up` on berry; 1.x ran `yarn update`, which is not a yarn command ([#37](https://github.com/pixel-perfect-software/always-up-to-date/issues/37)).
- Projects whose `outdated` output is over 1 MB no longer fail, and package names reach the package manager as arguments rather than through a shell ([#38](https://github.com/pixel-perfect-software/always-up-to-date/issues/38)).
- `--json` prints only the JSON document on stdout, for every command; warnings and errors go to stderr ([#40](https://github.com/pixel-perfect-software/always-up-to-date/issues/40)).
- `check` and `update` exit 1 and name the step that failed when a package-manager command fails; 1.x exited 0, and `update --json` printed `[]` ([#53](https://github.com/pixel-perfect-software/always-up-to-date/issues/53)).
- Moving a compound range, an x-range or an `npm:` alias past its range keeps its bounds and the alias. A spec that can't keep its shape is written in the project's save style (npm `save-exact` / `save-prefix`, pnpm `saveExact` / `savePrefix`, yarn berry `defaultSemverRangePrefix`, bun `exact`) ([#50](https://github.com/pixel-perfect-software/always-up-to-date/issues/50), [#65](https://github.com/pixel-perfect-software/always-up-to-date/issues/65)).
- package.json keeps its indentation, line endings and final newline when autd writes it ([#49](https://github.com/pixel-perfect-software/always-up-to-date/issues/49)).
- `npm:` aliases update on every package manager instead of failing the run ([#71](https://github.com/pixel-perfect-software/always-up-to-date/issues/71)).
- A single-package pnpm project whose pnpm-workspace.yaml only holds settings is no longer run as a workspace ([#68](https://github.com/pixel-perfect-software/always-up-to-date/issues/68)).

### Known issues
- npm can leave a package in place when another installed package depends on that exact version, and `update` still reports it as updated ([#76](https://github.com/pixel-perfect-software/always-up-to-date/issues/76)).
- `check` and `update` don't run on yarn 2+ (berry) yet, since it has no `outdated` command ([#79](https://github.com/pixel-perfect-software/always-up-to-date/issues/79)).
