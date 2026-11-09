# Changelog

Notable changes to `@pixel-perfect-software/always-up-to-date`, newest first. Versions before
2.0.0 were published without a changelog.

## 2026-11-09 — 4.0.0: every --json document is versioned and has one shape, and check --json plans

**Breaking:** `check --json`, `update --dry-run --json` and `update --json` now print one versioned document, `{ "version": 1, "autd", "command", "phase", "manager", "member", "rows": [...] }`, and every row carries a reason. Any script that reads 3.x `--json` output needs updating. The README's "Upgrading from 3.x" maps each old field to its new one. Human output is unchanged.

### Breaking

- `check --json` prints planned rows, as `update --dry-run --json` does: one row per package and manifest, with `target`, `outcome` and `reason` ([#201](https://github.com/pixel-perfect-software/always-up-to-date/issues/201)). Before, it was an object keyed by package name, with `workspaces` in a workspace project, and `update --json` printed an array. Since `check --json` now plans, a cold run reads a version manifest for each row that would move, about 0.3 s more on 40 dependencies. The reads are cached, and a warm run sends no request.
- `reason` is `{ code, message }` on every row, moving rows included. `message` is the text `reason` held before. `warning` is now `warnings: [{ code, message }]`.
- `updated` is replaced by `outcome`: `update`, `held`, `not-applied` or `not-targeted`.
- `target` is `null` on a held row. `workspace` is `"."` in a single-package project. `current` is `null` for a dependency that isn't installed (it was `"missing"`). `releaseAge` is `releaseAgeDays`, `null` when nothing judged the row.
- The error document is `{ "version": 1, "autd", "command", "error": { step, message, manifestWritten } }`. `step` is `null` for a failure outside a step, such as a malformed config. Before, the key was left out.

### Added

- `schema/output.schema.json`, the JSON Schema (draft-07) of every `--json` document. The `--json` option text names it. Within version 1, fields and reason codes may be added, so branch on `outcome`.
- A reason code on every row: 21 codes, among them `within-range`, `past-range`, `rule-latest`, `cooldown-fallback` and `engines-fallback`.
- The README documents the `--json` fields, outcomes and codes.

## 2026-11-08 — 3.6.0: autd holds updates that are deprecated, change the license, break a peer, or need a newer Node

`check` and `update` now hold a target that carries a warning sign, and print the reason. Each hold shows in its own section of the report. A `latest` rule still moves the package and puts the reason in the row's `warning`. The `--json` shape is unchanged: the new holds are `reason` text, and the `warning` field already existed. Reading a target's own manifest costs one registry request per package that would move, answered from the cache afterwards. `check --json` sends none.

### Added

- A target the registry marks deprecated is held as `deprecated: <message>` ([#195](https://github.com/pixel-perfect-software/always-up-to-date/issues/195)). If the installed version carries the same message, the row moves with the message as a warning, since holding would keep you on a version with the same deprecation. A different message holds. For example, `npm update` moves `next` 14.0.0 to 14.0.4 although every 14.0.x is deprecated, and autd now does the same.
- A target whose license differs from the installed version's is held as `license change: MIT → AGPL-3.0-or-later` ([#197](https://github.com/pixel-perfect-software/always-up-to-date/issues/197)). Case, whitespace, outer parentheses, operand order in a flat `OR` or `AND`, GNU's deprecated ids (`GPL-3.0` and `GPL-3.0-only`) and the file named by `SEE LICENSE IN` are not a change. `MIT/X11` against `MIT` is. A package whose manifest can't be read moves, and one warning lists it.
- A target whose own `peerDependencies` the plan leaves unmet is held as `peer conflict: react-redux@9.3.1 needs react ^18.0 || ^19 (installed 17.0.2)` ([#198](https://github.com/pixel-perfect-software/always-up-to-date/issues/198)). Each peer is judged against the version the plan leaves it at. Before, only the other direction was checked: an installed package's peer range on a moving package. With no `node_modules`, neither direction ran for npm's lockfile or berry's PnP. The target direction now reads the lockfile there. This matches npm's `ERESOLVE` and is stricter than pnpm and bun.
- A target whose `engines.node` excludes the project's Node is held as `engines: needs node >=22.12.0 (the project declares >=18)` ([#199](https://github.com/pixel-perfect-software/always-up-to-date/issues/199)). The project's Node is the `engines.node` in its `package.json` (a member's own, else the root's). When none is declared, it is the running Node, or `nodeVersion` from `pnpm-workspace.yaml` under pnpm. No manager judges by the project's declared range, so that part is autd's own check.

### Changed

- Under npm, a row whose in-range target needs another Node moves to the newest version npm would install ([#200](https://github.com/pixel-perfect-software/always-up-to-date/issues/200)). The reason reads `engines: 1.2.0 needs node >=99 (running node 24.22.1)`. Before, autd proposed 1.2.0 and reported `not applied by npm (installed 1.1.0)`. The walk tries at most 5 candidates, and `update` installs the chosen version exactly and restores the range. pnpm and bun install the highest version whatever the engines, so they keep the old plan, and the new engines hold covers them. yarn is untested.
- Each hold has its own section in the report (**Held as deprecated**, **Held for a license change**, **Held by engines.node**), and the peer-conflict section now includes the target's own peers.

### Known issues

- The installed-package peer check still can't see peers without `node_modules`.
- yarn v1 and berry are untested for npm's engines preference, so they keep the old plan.
- Nested parenthesised license expressions are compared as written, so a reordered one shows as a hold that a `latest` rule clears.

## 2026-11-06 — 3.5.0: cooldown and release-age gates stop downloading full registry documents, and a throttled run says so

Publish times for cooldown and the release-age gates now come from deps.dev, a cached document, or a package's `modified` date, so most packages cost no full registry document. The CLI is one bundled file, and `--version` starts about 28 ms faster. autd warns when a registry throttles a run.

### Added

- autd warns when a registry answers 429 during a run: `⚠️ Throttled by registry.npmjs.org (40 requests), so this run was slower than usual`. The results stay correct, since autd falls back to the packument. Only the time shows it. Under `--json` the warning goes to stderr, and `silent` suppresses it ([#174](https://github.com/pixel-perfect-software/always-up-to-date/issues/174)).

### Changed

- Cooldown and the release-age gates no longer download a package's full document on every run ([#47](https://github.com/pixel-perfect-software/always-up-to-date/issues/47)).
  - **deps.dev's dates:** when deps.dev doesn't list a package's `latest`, autd keeps the publish dates deps.dev does have. Before, every version came back undated.
  - **Request limits:** a full document is requested only when a version being judged still has no date, once per package per run. The request goes through the per-host limiter and the disk cache.
  - **Cache:** publish times never change, so a stored document that lists every version answers at any age. An authenticated entry is revalidated on every use, which costs a 304 with no body.
  - **Fallbacks:** a cooldown fallback can no longer land on an unpublished version.
  - **Measured:** with `depsDev: false` on 40 packages, a warm run on pnpm made no request. Before, it made 79 to 80 registry requests, one full document per target.
- A package whose abbreviated packument says it was last modified before the gate is let through without reading its full document ([#177](https://github.com/pixel-perfect-software/always-up-to-date/issues/177), [#190](https://github.com/pixel-perfect-software/always-up-to-date/pull/190)). This applies to pnpm's, bun's and npm's release-age settings, and to npm's `before`, on public npm registries. Berry's `npmMinimalAgeGate` still reads the dates, since berry quarantines a version with no date. So does a cooldown, which keeps its exact `releaseAge`.
  - **Measured:** `check` with `depsDev: false` on 40 packages and pnpm's default gate read 6 full documents, against 40, and sent 46 registry requests, against 80. It took 1.37 s cold, against 2.00 s, with peak memory of 534 MB, against 780 MB.
- A fresh cached packument that lists `latest` answers without asking deps.dev again ([#188](https://github.com/pixel-perfect-software/always-up-to-date/pull/188)). Before, one package deps.dev lagged on sent a request on every warm `check`, and loaded the registry client. On `zustand`, a warm `check` took 61 ms, against 212 ms.
- The CLI is one bundled file ([#109](https://github.com/pixel-perfect-software/always-up-to-date/issues/109)). `autd --version` loads 2 modules, against 111, and runs 8.3 ms over bare Node, against 36.7 ms. `help` is 15.5 ms over. `semver`, `commander` and `colorette` are bundled, so `@inquirer/prompts` is the one runtime dependency. The package ships `dist/third-party-licenses.txt` for the bundled ones.

### Fixed

- The debug output no longer calls a 304 a download ([#176](https://github.com/pixel-perfect-software/always-up-to-date/issues/176)). A revalidation logs `Revalidated the full packument of <name> for publish times (304)`, and `Reading the full packument of <name> …` appears only when a body came back. The run summary counts a stored document that answered past its TTL as `covered`.

### Known issues

- Cooldown with `depsDev: false` still reads each moving row's full document once, to keep `releaseAge` exact.
- The `modified` shortcut applies to public npm registries only, so a private registry or a registry proxy keeps the full read under a release-age gate.

## 2026-11-03 — 3.4.0: yarn 2+ checks without running yarn, and autd respects the package managers' release-age gates

`check` on yarn 2+ reads `yarn.lock` and the registry itself and runs no `yarn` command. Its registries and tokens come from `.yarnrc.yml`. autd no longer proposes a version a package manager won't install for its age: pnpm and yarn 2+ refuse versions under a day old by default, and npm's and bun's release-age settings are honored when set. An npm project with a lockfile but no `node_modules` can be checked. On yarn v1, registry tokens follow yarn's rules, and a workspace member's update resolves through the root's registry settings, as `yarn install` does.

### Added

- An npm project with `package-lock.json` and no `node_modules` can be checked: a fresh clone, CI before `npm ci`, or a lockfile from `npm install --package-lock-only`. Installed versions come from the lockfile, a member's own copy first, then the root's. Before, `check` stopped with "Nothing is installed in … (no node_modules): run `npm install`, then check again." pnpm, yarn v1 and bun still ask for an install ([#107](https://github.com/pixel-perfect-software/always-up-to-date/issues/107)).
- autd honors each package manager's release-age gate: it never proposes a version the manager refuses because it is too new. This covers `check`, a past-the-range target, and a cooldown fallback ([#166](https://github.com/pixel-perfect-software/always-up-to-date/issues/166), [#168](https://github.com/pixel-perfect-software/always-up-to-date/issues/168)).
  - **pnpm:** `minimumReleaseAge`, in minutes, one day unless set. It is read from `pnpm-workspace.yaml`, the global `config.yaml` and `pnpm_config_minimum_release_age`. `minimumReleaseAgeExclude` exempts names, globs and exact versions.
  - **yarn 2+:** `npmMinimalAgeGate`, one day unless set. A scope listed in `npmScopes` has its own gate. `npmPreapprovedPackages` exempts names or globs, with an optional range.
  - **bun:** `[install] minimumReleaseAge`, in seconds, off unless set. `minimumReleaseAgeExcludes` exempts exact names, with an optional version.
  - **npm:** `min-release-age`, in days, and `before`, both off unless set. `min-release-age-exclude` exempts names and globs.
  - Before, autd proposed the version the manager then refused. With pnpm's default, a package published within the day was proposed, pnpm installed an older one, and the report said `not applied by pnpm (installed 1.0.1)`. Verified on pnpm 12.16.1, yarn 4.18.1, bun 1.4.4 and npm 12.2.1.

### Changed

- yarn 2+ discovery no longer runs `yarn info` or `yarn npm info` ([#107](https://github.com/pixel-perfect-software/always-up-to-date/issues/107)).
  - **Installed versions:** from `yarn.lock`, with PnP or the node-modules linker. The check after an update reads `yarn.lock` too.
  - **`wanted`:** the highest version the range allows, skipping deprecated ones, as yarn 4.18.1 resolves it. A newer `latest` tag no longer wins.
  - **Measured:** on a 12-package workspace, `check` took 0.35 s, against 1.29 s, with no cache, and 0.08 s, against 1.37 s, cached.
- yarn 2+ registries and tokens come from `.yarnrc.yml`, merged across the project's file, its parents' and `~/.yarnrc.yml`, with `YARN_*` variables over them ([#107](https://github.com/pixel-perfect-software/always-up-to-date/issues/107)):
  - `npmRegistryServer`, `npmScopes`, `npmRegistries`, and `npmAuthToken` / `npmAuthIdent` / `npmAlwaysAuth`, by yarn 2+'s own rules;
  - `httpsCaFilePath`, `httpProxy` / `httpsProxy`, `httpTimeout`, `httpRetry` and `networkConcurrency`.

  `.npmrc` and the `HTTP_PROXY` / `HTTPS_PROXY` variables are ignored, as yarn 2+ ignores them. Before, autd read npm's `.npmrc` for a yarn 2+ project, so cooldown asked the wrong registry, without the project's token, and held every move as `release date unknown`.
- yarn v1: a workspace member's update resolves with root installs, through the root's registry settings ([#127](https://github.com/pixel-perfect-software/always-up-to-date/issues/127)). autd pins the exact version, installs, puts the manifest back, and relocks `yarn.lock`. Before, autd ran `yarn workspace <name> upgrade`, which reads the member folder's settings, where `~/.npmrc` outranks the root's `.npmrc`. A developer's own `registry=` could then win over the repo's, and its URLs were written to `yarn.lock`.
- Registry settings are read where autd runs the package manager: the project root, whatever folder `autd` is run from ([#127](https://github.com/pixel-perfect-software/always-up-to-date/issues/127)).
- The published package's `semver` is 7.8.6 (was 7.8.5).

### Fixed

- yarn v1 sends a registry token only for a scoped package or with `always-auth`, and falls back to a bare `_authToken`, `_auth`, `username` and `_password`, as yarn 1.22.22 does ([#126](https://github.com/pixel-perfect-software/always-up-to-date/issues/126)). Credentials are looked up by the package's registry, not by walking up the request URL's path, and a redirect to another hostname drops them. Before, autd sent a token for unscoped packages, which yarn never does, and none to a private scope set up with a bare `_authToken`, so `check` failed with a 404.
- yarn v1: a member's in-range update to a range another dependency also requests (`shared@^1.0.0`) moves both, as `yarn upgrade` does ([#127](https://github.com/pixel-perfect-software/always-up-to-date/issues/127)).

### Known issues

- Cooldown still reads full registry documents for its dates, uncached. So does a release-age gate, when a registry's document lacks publish times ([#47](https://github.com/pixel-perfect-software/always-up-to-date/issues/47)).
- yarn 2+ with PnP: installed peer ranges aren't read, so no update is held for a peer conflict.
- yarn 2+: `networkSettings` and the client-certificate settings in `.yarnrc.yml` aren't read.
- pnpm: when every version a range allows is under the gate, pnpm installs the lowest. autd leaves the package where it is, with a warning.

## 2026-10-30 — 3.3.0: run from a workspace member, and an update no longer rewrites your peer range

autd runs from inside a workspace member. There, `check` and `update --dry-run` cover only that member, and `update` points you to the workspace root. Before, it found no package manager there. A past-the-range update no longer rewrites a matching `peerDependencies` range. yarn v1 workspaces no longer upgrade a member's every dependency, or copy a devDependency into `dependencies`. Two cooldown fallback bugs from 3.2.0 are fixed.

### Added

- From a workspace member, or a directory inside one, `check` and `update --dry-run` cover only that member's `package.json`, plus a `catalog:` entry it references. `check --json` keeps the workspace shape, and its `workspaces` field lists the one member ([#123](https://github.com/pixel-perfect-software/always-up-to-date/issues/123)).
  - **The workspace root:** autd finds it the way the member's package manager does:
    - npm, yarn v1 and bun: the nearest folder whose `workspaces` lists the member.
    - pnpm: the nearest `pnpm-workspace.yaml`.
    - yarn 2+: the nearest `yarn.lock`.
  - **Detection:** it reads the root's lockfile, and the nearest `packageManager` declaration between the member and the root. `--pm yarn` in a yarn 2+ workspace now takes yarn 2+'s path, and no yarn v1 `.yarnrc` applies.
  - **Config:** the member's own `.always-up-to-date.json`, else the root's. `autd init` writes it where it is read: the nearest `package.json`'s folder.

### Changed

- `update` from a workspace member is refused before anything runs. Before, a member run found no package manager unless `--pm` was passed. The message: `update runs from the workspace root, because it writes the lockfile every workspace shares: run autd update in <root> (autd update --dry-run previews this member's updates here)`. This covers plain `update`, `update <packages>` and `-i`. Every manager also moves the shared lockfile's copies of a package in the other workspaces, so a member update was never only the member's ([#123](https://github.com/pixel-perfect-software/always-up-to-date/issues/123)). The root updates as before, and so does a folder that is its own project: a pnpm member with its own `pnpm-workspace.yaml`, or a folder no `workspaces` lists.

### Fixed

- A past-the-range update leaves the package's own `peerDependencies` range alone, as the package managers' own update commands do. Before, a library with `react` as a peer (`^18.0.0`) and a dev dependency ended with `peerDependencies.react: "^19.3.1"` after a `beyondRange: "major"` update. That dropped its React 18 consumers, and nothing in the report said so. This happened on npm, pnpm, yarn 2+ and bun ([#155](https://github.com/pixel-perfect-software/always-up-to-date/issues/155)).
- yarn v1 workspaces: a member's devDependency or optionalDependency update is one `workspace <name> upgrade`, with no `-D` or `-O`. yarn 1.22.22 ignores those flags on `upgrade`, so it upgraded every dependency of the member and copied the package into `dependencies`. That happened from the root too ([#123](https://github.com/pixel-perfect-software/always-up-to-date/issues/123)).
- A cooldown fallback below `wanted` must satisfy the range `package.json` declares. With `"ms": "^0.7.1 || ^2.1.3"`, autd picked 2.1.2, which that range excludes, and the package manager then installed 2.1.3, the version the cooldown held. The report also said it had updated. Now a row with a fallback counts as applied only when installed at exactly its target ([#151](https://github.com/pixel-perfect-software/always-up-to-date/issues/151)).
- yarn v1 lockfile keys are quoted as yarn quotes them, so a restored range with spaces, such as `"ms@^0.7.1 || ^2.1.3"`, reads back ([#151](https://github.com/pixel-perfect-software/always-up-to-date/issues/151)).
- An `npm:` alias's cooldown reads its target's release dates. Before, `"m": "npm:ms@^2.0.0"` was judged by the registry's `m`, another package, so every move was held as `release date unknown`. On yarn, its fallback is relocked under the alias's target, so `update` no longer fails with `yarn.lock: no key for m@2.1.2` ([#152](https://github.com/pixel-perfect-software/always-up-to-date/issues/152)).

### Known issues

- yarn 2+ still runs the manager to find outdated packages ([#107](https://github.com/pixel-perfect-software/always-up-to-date/issues/107)). With PnP, installed peer ranges aren't read, so no update is held for a peer conflict.
- yarn v1's `always-auth`, its bare `_authToken`, and a member's own `.npmrc` during its upgrade are still read differently from yarn ([#126](https://github.com/pixel-perfect-software/always-up-to-date/issues/126), [#127](https://github.com/pixel-perfect-software/always-up-to-date/issues/127)).
- Cooldown still reads full registry documents for its dates, uncached ([#47](https://github.com/pixel-perfect-software/always-up-to-date/issues/47)).

## 2026-10-27 — 3.2.0: cooldown moves a package to the newest version past it, and pnpm's leftover packages no longer hold updates

When the newest version a package could move to is too fresh for `cooldown`, the package now moves to the newest version that is old enough, and is held only when there is none. Before, it stayed where it was, so a package that publishes more often than the cooldown never moved. In pnpm projects, a package pnpm has removed but not yet deleted from `node_modules/.pnpm` no longer holds updates with its peer ranges.

### Changed

- Cooldown falls back to the newest version between the installed one and the held one that is past cooldown for its own update type and not deprecated. The report names the version it skipped: `4.0.101 → 4.0.102  within range; 4.0.103 released 1d ago, needs 2d` ([#147](https://github.com/pixel-perfect-software/always-up-to-date/issues/147)). The range in package.json is kept: autd installs the exact version, then puts the range back and installs again; on yarn it also records the range against that version in `yarn.lock`. Verified on npm 11.19.1, pnpm 12.14.0, bun 1.4.4, yarn 1.22.22 and yarn 4.12.0.
- The published package pins its runtime dependencies to exact versions: `@inquirer/prompts` 8.7.5, `colorette` 2.0.20, `commander` 15.0.0 and `semver` 7.8.5. 3.1.0 used `^` ranges.

### Fixed

- In pnpm projects, the peer check reads only packages that `node_modules/.pnpm/lock.yaml` lists. pnpm keeps a removed package in `.pnpm` for up to 7 days (`modules-cache-max-age`), and its peer ranges used to hold updates: `storybook` 10.6.3 → 10.6.5 was held by `@storybook/addon-jest@9.1.12`, which no manifest listed ([#146](https://github.com/pixel-perfect-software/always-up-to-date/issues/146)).
- The README no longer says a failed cooldown lookup lets the update through; since 3.1.0, it holds the version ([#147](https://github.com/pixel-perfect-software/always-up-to-date/issues/147)).

### Known issues

- yarn 2+ still runs the manager to find outdated packages ([#107](https://github.com/pixel-perfect-software/always-up-to-date/issues/107)). With PnP, installed peer ranges aren't read, so no update is held for a peer conflict.
- Run from inside a workspace member, autd finds no package manager ([#123](https://github.com/pixel-perfect-software/always-up-to-date/issues/123)).
- yarn v1's `always-auth`, its bare `_authToken`, and a member's own `.npmrc` during its upgrade are still read differently from yarn ([#126](https://github.com/pixel-perfect-software/always-up-to-date/issues/126), [#127](https://github.com/pixel-perfect-software/always-up-to-date/issues/127)).
- Cooldown still reads full registry documents for its dates, uncached ([#47](https://github.com/pixel-perfect-software/always-up-to-date/issues/47)).
- A cooldown fallback for a yarn `npm:` alias fails `update` with an `apply` error naming `yarn.lock`. For a range with a gap, such as `^1 || ^3`, the fallback can pick a version the range excludes ([#147](https://github.com/pixel-perfect-software/always-up-to-date/issues/147)).

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
