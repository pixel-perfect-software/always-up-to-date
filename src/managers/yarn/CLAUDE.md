# yarn adapter (v1 and berry)

## Overview

One adapter serves yarn v1 (1.22.22) and berry (2+, verified on 4.12.0 and 4.18.1), told apart by `isYarnBerry`. They share almost nothing: v1 reads `.npmrc` layers and `.yarnrc`, sends credentials by its own rule and applies with `upgrade` (members through root installs); berry reads only `.yarnrc.yml`, is discovered from `yarn.lock`, holds a one-day release-age gate by default and applies with `install` and `up -R`. The shared contract is in `src/managers/CLAUDE.md`; the registry machinery in `src/utils/REGISTRY.md`.

## Key Files

| Path           | Role                                                                                                                                                                                                                   |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`     | The adapter (v1 `upgrade`, berry's `install` / `up -R`), `isYarnBerry`                                                                                                                                                 |
| `npmrc.ts`     | `yarnNpmrcLayers()`, `YARN_NPM_ENV`: yarn v1's `.npmrc` layers (cwd, user, prefix, parents); `yarnV1AuthOptions()`: what its credential rule reads (#126)                                                              |
| `yarnrc.ts`    | `parseYarnrc()`, `yarnrcRoutes()`, `yarnRegistryConfig()`: registry routes from yarn v1's `.yarnrc`                                                                                                                    |
| `yarnrcYml.ts` | `parseYarnrcYml()` (a YAML subset), `substituteBerry()`, `berryRcFiles()`, `berrySettings()`, `berryRegistryConfig()`: yarn berry's registry settings from `.yarnrc.yml` and `YARN_*` (#107)                           |
| `berry.ts`     | berry: `readBerryLock` (installed versions from yarn.lock, #107), `readBerryLockPeers` (#232), `applyBerry`, `yarnProjectDir`, `berryProjectRoot`                                                                      |
| `lockfile.ts`  | `rewriteYarnV1Lock`, `rewriteBerryLock`: record a range against a version locked under another spec (pin relock, integration harness); v1 moves the range off any other entry (#127)                                   |
| `graph.ts`     | `readYarnV1Graph()` (descriptors in yarn.lock, importers from the members' package.json), `readBerryGraph()` (yarn.lock entries, workspace entries as importers): the installed graph for the peer pass, no peer edges |

## v1 or berry

`isYarnBerry(dir)` (also decides save style and overrides): from `dir` up to the yarn project's directory (`yarnProjectDir`: the nearest `yarn.lock`, else the nearest ancestor listing `dir`), the nearest `packageManager: yarn@N` decides (2+ is berry); otherwise a `.yarnrc.yml` in that walk means berry, so a berry workspace member is berry. A member without its own `packageManager` is so judged by its root's. The choice is made once per load, in `npmrcLayers`, and `registryConfig` follows it.

## yarn v1: `.npmrc` (verified on yarn 1.22.22, 2026-10-26, probes y20-y32; #122)

Layers, highest first, each key (credentials too) from the first that sets it, with `registryConfig` adding the `.yarnrc` files below:

1. `npm_config_*` env, any case of the prefix; the name is lower-cased, `__` is `.` and a single `_` is `-`, and a key holding `.` is skipped. So `NPM_CONFIG_@ACME:REGISTRY` is `@acme:registry`, and a `//host/:_authToken` variable is mangled and never read: no credential comes from the environment. Values are used as written (no `${VAR}`), and an empty value is kept: it hides the same key in every `.npmrc` (an empty `NPM_CONFIG_REGISTRY` sends the default to the `.yarnrc` or yarn's own; an empty scope variable unroutes the scope, leaving a `.yarnrc` scope), unlike npm's, where an empty setting is skipped. `true` / `false` become booleans (probes a1, a1c, a2, a2c, 2026-10-27)
2. the cwd's `.npmrc` (a workspace member's own when yarn runs from one; autd reads the view at the project root, where it runs yarn, #127)
3. the user file: `npm_config_userconfig` (any case) resolved against cwd, with no `~` expansion and a missing file meaning no user file; else `~/.npmrc`
4. `${PREFIX, else the running node's prefix}/etc/npmrc`
5. each parent directory's `.npmrc`, nearest first, not the filesystem root

- A parent's `.npmrc` beats a project `.yarnrc` (the `.yarnrc` is only consulted when no `.npmrc` sets the key). `${VAR}` expands in file _values_ only, never in keys (`//${HOST}/:_authToken` never matches a host; b1). yarn's rule: the name is everything up to `}`, so `${TOKEN?}` names a variable `TOKEN?` and fails the run whether `TOKEN` is set or not; a reference behind an odd run of backslashes is kept as written, backslash included (`\${X}` stays `\${X}`, c1, c4). yarn aborts on an unset variable in any `.npmrc` it reads; autd keeps an unresolvable reference literal, and a credential still holding `${…}` is dropped, so `${TOKEN?}` sends no credential (c2, c3)
- Limitation: Homebrew's yarn wrapper forces `PREFIX=/opt/homebrew`, so Homebrew yarn reads `/opt/homebrew/etc/npmrc` whatever `PREFIX` is; autd reads `$PREFIX/etc/npmrc` or the node prefix's, so they differ unless autd runs with the same `PREFIX`. Corepack and `npm i -g` yarn honor `PREFIX`. `DESTDIR` (yarn joins it to the default prefix on Unix) is not read, and a different Node between yarn and autd gives a different default prefix
- From a member, v1's layers would be the member's, `~/.npmrc`, then the parents' (the root's included), but autd loads every manager's view at the project root, where it runs the manager (#127)
- Not read: the root user's `/usr/local/share/.npmrc` on Linux (yarn reads it in place of `~/.npmrc`, then `~/.npmrc` after the prefix file; verified in Docker, node:24, yarn 1.22.22, 2026-10-27), `DESTDIR`, `/.npmrc` (yarn doesn't read it either), `${VAR?}`

## yarn v1: credentials (#126; verified on yarn 1.22.22, 2026-11-03, probes c01-c20 against local registries logging `Authorization`)

yarn's hook sets `RegistryConfig.yarnV1Auth` (`yarnV1AuthOptions`: the view's `_authToken`, `_auth`, `username`, `_password` and `always-auth` keys, bare or under a registry, `https://host/:` keys included; a credential holding `${…}` left out), and the client replaces npm's prefix walk with `yarnV1AuthorizationFor` for the Authorization header:

- only to a package's route (never deps.dev), only for a scoped package or with `always-auth` (the route's or bare, truthy, so a route's `false` falls through to a bare `true`)
- looked up by the route as `yarnV1RegistryKeys` lists (with and without the protocol, then without a trailing `registry/`; no walk up, so `//host/:_authToken` doesn't reach `//host/npm/`), each field falling back to its bare key (`_authToken=U` alone authenticates every scoped package). With no default registry set, yarn's own (`registry.yarnpkg.com`) is the route looked up, then `registry.npmjs.org`'s
- A redirect keeps the header on the same hostname (any port) and drops it on another, as yarn's `request` does. Client certificates still come from `credentials`
- yarn fails the run on an unset `${VAR}` in a credential; autd drops that key, so a bare one can stand in (c19)

## yarn v1: `.yarnrc` (`yarnrc.ts`; verified on yarn 1.22.22, 2026-10-26, with `yarn install` / `yarn upgrade` and `yarn config get`; #120)

- Default registry `--upgrade.registry` in a `.yarnrc` (`yarn upgrade` only; other commands' `--<cmd>.registry` are ignored) > `--registry` > `npm_config_registry` > `YARN_REGISTRY` > `.npmrc` `registry` > `.yarnrc` `registry`; a scope `npm_config_@scope:registry` / `.npmrc` > `.yarnrc` `"@scope:registry"`, and any scope beats every default, the flags included
- Among `.yarnrc` files an ordinary key is read from the cwd (a workspace member when run from one), then `~/.yarnrc`, then the parent directories nearest first, not the filesystem root; the flags take `~/.yarnrc` first, then cwd and parents, the root's file included. Variables are matched like `npm_config_*`: any case, empty skipped, last wins. Routes only, over the view of yarn's own `.npmrc` layers: a `.yarnrc` carries no credentials (`"//host/:_authToken"` sends nothing), so those stay with `.npmrc`. A berry project's `.yarnrc` is ignored
- Syntax is yarn's lockfile grammar: keys with `@` or `:` and URL values must be double-quoted; `#` comments, CRLF and a BOM are fine; an even-indented line ends the file for yarn (keys before it count); an odd indent, a tab outside a comment, single quotes, an unquoted URL, or a YAML-style file (`registry: https://…`) make yarn fall back to YAML, and autd reads the file as empty
- Not read: `${PREFIX or dirname(execPath)}/etc/yarnrc` (ordinary keys, between `~/.yarnrc` and the parents); `/etc/yarnrc`, `/etc/yarn/config`, `~/.config/yarn/config` and `~/.yarn/config` (the flags, above the project); `YARN_@SCOPE:REGISTRY` variables
- `emptyRegistry`: yarn skips an empty default and an empty scope. Not mirrored: yarn also fails the whole run on an unset `${VAR}` in a shadowed `.npmrc` registry line

## yarn v1: apply

- yarn writes the manifest itself: autd passes `name@spec` descriptors from `buildUpdateDescriptors()` and never pre-writes `package.json` (v1 then fails with "Outdated lockfile")
- v1 runs `yarn upgrade <descriptors>` for the root's own rows (in range: `upgrade name@<current spec>`, which installs `wanted` and leaves package.json alone); it has no `update`. At a workspace root, `upgrade` touches the root manifest only and copies nothing between its fields (p1-rootdev), so the root keeps yarn's own write. No `--recursive`: v1 ignores it. Packages a manifest does not list are skipped with a warning naming it: v1 `upgrade` at a workspace root adds them as root dependencies
- Members (#127): a package moving in a member never reaches `apply`. `pinMembers` makes `splitUpdates` pin all its moving rows, and `applyPinned` moves them with root installs (exact pins, `install`, every manifest put back byte for byte, beyond-range specs written, `rewriteYarnV1Lock`, `install`). yarn's one per-member command, `workspace <name> upgrade`, runs yarn in the member directory, which reads that directory's `.npmrc` and `.yarnrc` and ranks `~/.npmrc` above the root's `.npmrc`. A root `install`, `outdated` and `upgrade-interactive` read the root's (yarn 1.22.22, 2026-11-03, m1-m4: a member `.npmrc`, `~/.npmrc` scope or `registry=`, or a member `.yarnrc` sent the member's upgrade to registry B, and the root install to A). The pin path also never copies a devDependency into `dependencies` (`-D` / `-O` are not `upgrade` options in 1.22.22; the integration matrix caught `workspace <name> upgrade` duplicating member devDependencies there), needs no member name and no `install --check-files`. A member manifest that reaches `apply` anyway is an `apply` StepError. A `--upgrade.registry` flag in a `.yarnrc` routes the root's `upgrade` but not the pin path's `install`
- `run` passes `manifestWritten: false` (yarn writes its own manifest) until it has written a member's beyond-range specs
- Overrides: yarn v1 does not apply `resolutions` to a direct dependency, so nothing is held. stderr: v1 on Node 24 always prints a DEP0169 warning, logged at debug level. v1 doesn't freeze `install` under `CI`
- Frozen install in the integration matrix: `yarn install --frozen-lockfile`

## Berry: registries (`yarnrcYml.ts`; verified on yarn 4.18.1, 2026-11-03, probes r01-r30 and `yarn config get --json`, each row a case in `__tests__/utils/registryRequest.test.ts` and `__tests__/managers/yarnrcYml.test.ts`; #107)

No `.npmrc` is read (r19), so `npmrcLayers` is empty and `registryConfig` builds the whole config:

- Files: `.yarnrc.yml` (or `YARN_RC_FILENAME`) in the project directory and every parent, nearest first, then the home directory's. A scalar comes from the first that sets it; `npmScopes` and `npmRegistries` merge per entry and per key (r15), and two `npmRegistries` keys that differ by a trailing `/` are one registry whose nearer file's entry wins whole; `unsafeHttpWhitelist` concatenates every file's. `YARN_<SETTING>` (`YARN_NPM_REGISTRY_SERVER`) beats the files (r11, r12, r29). String values go through `substituteBerry`, ported from 4.18.1's bundle (`${A}`, `${A-x}`, `${A:-x}`, nesting, `\$` escapes); one that fails (an unset `${A}`, r18) is left out with a debug line, where berry fails the run. `parseYarnrcYml` reads block maps and sequences, quoted and plain scalars and flow sequences; scalars stay strings and are coerced per setting (booleans `true`/`1`/`false`/`0`, `httpTimeout` a DURATION such as `30s`). Berry's YAML reading leaves `parseYaml`'s `flowMaps` and `anchors` off, so berry still drops a flow map or an anchored key
- Routes: `npmRegistryServer` (default `https://registry.yarnpkg.com`) and `npmScopes.<scope>.npmRegistryServer` (`@` optional in the key). A value that isn't an http(s) URL, or an `http:` one whose host `unsafeHttpWhitelist` doesn't match (globs), is `unusable`, as berry refuses it
- Credentials: `RegistryConfig.berryAuth` (`top`, `scopes`, `registries`), applied by `berryAuthorizationFor`: the scope's configuration if it holds a token or ident (`npmAuthToken` / `npmAuthIdent`), else the `npmRegistries` entry for the route (one trailing `/` dropped, then without the protocol; no walk up the path), else the top level; a scoped package sends what it holds, an unscoped one only with that configuration's own `npmAlwaysAuth` (an entry doesn't inherit the top level's); token as Bearer, ident as Basic (base64-encoded when it holds `:`). Only to a package's route; on a redirect, only to the first hop's origin (r25, r26, unlike yarn v1)
- Network: `httpsCaFilePath` (relative to the file that sets it), `enableStrictSsl`, `httpProxy` / `httpsProxy` (berry ignores `HTTP_PROXY` / `HTTPS_PROXY`, r27; no `NO_PROXY`), `httpTimeout` (default 1m), `httpRetry` (3), `networkConcurrency` (50, as `maxSockets`)
- Not read: `networkSettings` (per-host globs), `httpsKeyFilePath` / `httpsCertFilePath`, plugins' authentication hooks, `YARN_*` forms of the map settings (`npmScopes`, `npmRegistries`); a YAML construct the reader doesn't take (flow map, anchor, block scalar) drops only that key

## Berry: release-age gate (#166; the rule from 4.18.1's bundle, `Wxe` / `Rvt` / `Qvt` / `Tvt`, and probes)

`npmMinimalAgeGate` (a DURATION in minutes, default `1d`; `YARN_NPM_MINIMAL_AGE_GATE` too) for an unscoped package or a scope without an `npmScopes` entry; a scope with an entry takes that entry's own gate, one day unless set, even when the top level is 0. `npmPreapprovedPackages` (concatenated across files) exempts a name or name glob, with an optional range (`p-exempt`, `@acme/*@^1.0.0`). It becomes `RegistryConfig.releaseAgeGate` in `berryRegistryConfig` (not the `releaseAgeGate` hook). A version with no publish time is quarantined, as berry treats it (`missingTime: 'held'`, so the `modified` shortcut never applies), and a package with none let through is left out with a warning. A security default of the manager's: autd never proposes what the manager refuses (`src/utils/REGISTRY.md`).

## Berry: discovery and apply (`berry.ts`)

Berry has no `outdated` (`yarn outdated` runs a script of that name). Since #107 it is discovered natively, and `check` runs no `yarn` command. Verified on yarn 4.12.0 and 4.18.1 with PnP and with `nodeLinker: node-modules`.

- `projectRoot`: the nearest `yarn.lock`'s directory, else as v1 (`berryProjectRoot` over `yarnProjectDir`), and a `detect` `StepError` for a directory that root's `workspaces` do not list, as berry refuses it
- Installed versions (`readBerryLock`, the adapter's `installedFromLockfile`, PnP or not): each workspace's entry `<name>@workspace:<path>` lists the descriptor yarn resolved for every key it declares, devDependencies included (`ms: "npm:~2.1.1"`, an alias's `m: "npm:ms@^2.0.0"`). The entry whose comma-separated key list holds `<key>@<descriptor>` gives `version`. A `workspace:` descriptor is a member, so it is linked and never looked up. A builtin patch is keyed apart (`resolve@patch:resolve@npm%3A^1.22.0#optional!builtin<compat/resolve>`) and locks the same version, so the workspace's own `npm:` descriptor is read. The file is read with `parseYarnrcYml` (the lockfile is YAML)
- `wanted`: the shared rule without the `latest` preference (`prefersLatestInRange: false`). 4.18.1 resolves a range to its highest non-deprecated version that `npmMinimalAgeGate` (default `1d`) lets through, and fails when the gate drops every satisfying version. autd applies the same gate to every lookup, so `wanted`, `latest` and cooldown fallbacks are versions berry installs
- Apply (`applyBerry`): each manifest in `plan.manifests` with beyond-range rows is written by `updatePackageJson` (the save style comes from `.yarnrc.yml` `defaultSemverRangePrefix`, `''` = exact), then `yarn install --no-immutable` if anything was written (`--no-immutable`: on CI yarn refuses an install that changes `yarn.lock`), then `yarn up -R <withinRange…>` if any. `up -R` re-resolves those packages to the highest version their existing ranges allow, project-wide, and leaves package.json alone. `yarn up name@range` would set that range in every workspace using the package, so it is not used. The project-wide in-range command is what `holdTogether` already assumes. `up -R` also re-resolves transitive copies of those packages within their own ranges, which the plan doesn't list
- Post-apply check: `installed` reads `yarn.lock` again (`readBerryLock`), each row from its own workspace's entry (PnP has no node_modules; v1's `installed` is the node_modules reader)
- Installed peer ranges under PnP (#232, `readBerryLockPeers`): each locked entry's `peerDependencies`, named by its `resolution`, once per `name@version`; with the node-modules linker `readInstalledPeers` reads node_modules as before. Unverified: the capture holds no `peerDependencies` (debug 4.3.7 has only `peerDependenciesMeta`), so the integration matrix is the first check of the field's shape
- Overrides: berry `resolutions`
- Not covered: yarn `catalog:` specs (the spec is not rewritten, so a beyond-range move is reported `not applied`)
- Frozen install in the integration matrix: `yarn install --immutable`

## Installed graph (`graph.ts`, for the peer pass; yarn 1.22.22 and 4.18.1 captures, 2026-11-12)

- `installedGraph` reads yarn.lock for both, whatever the linker, with no peer edges (neither lockfile records a resolved peer). v1 has no workspace entries: importers come from each member's package.json, resolved by `name@range` descriptor, and a workspace package (no entry) is skipped; v1 text without its `# yarn lockfile v1` header is another format. Berry: an entry's `resolution` `<name>@npm:<version>` is a node (an alias's is its target), `@workspace:<path>` an importer; a patch, git or file resolution is no node, and a `__metadata`-less file is another format

## Cooldown fallbacks: relock (#147, #151, #152)

yarn 1.22.22 and 4.12.0 key `yarn.lock` by spec and resolve the restored range again to the newest, so the adapter's `pinning` has `relock` with `rewriteYarnV1Lock` / `rewriteBerryLock` (`lockfile.ts`, shared with the integration harness). `rewriteYarnV1Lock` quotes a key as yarn 1.22.22 does (`shouldWrapKey`): a bare key holding a space, such as `ms@^0.7.1 || ^2.1.3`, reads back as another pattern, and yarn resolves the range again. Both rewriters find an `npm:` alias under its target, as yarn 1.22.22 and 4.12.0 lock it (`m@npm:ms@2.1.2`, and in berry's workspace entry `m: "npm:ms@2.1.2"`), and record the alias's restored spec against it; verified on all five managers with `"m": "npm:ms@^2.0.0"`, 2026-10-29 (#152).

## Engines

yarn v1 and berry: not verified (Corepack was unreachable), so they keep today's behavior: no `skipsEnginesExcluded`. It takes `cwd` for the yarn adapter, which serves v1 and berry.
