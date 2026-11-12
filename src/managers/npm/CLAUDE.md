# npm adapter

## Overview

What is specific to npm: its `.npmrc` layers (the default for any adapter without its own), `package-lock.json` as the installed versions when there is no `node_modules`, its release-age gate, its engines preference, and its apply. The shared contract is in `src/managers/CLAUDE.md`; the registry machinery in `src/utils/REGISTRY.md`.

## Key Files

| Path                       | Role                                                                                                                                                                       |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `index.ts`                 | The adapter; `readLockedPackages()` (installed versions from package-lock.json, #107), `readLockedPeers()` (the hoisted entries' peer ranges, #232), `npmReleaseAgeGate()` |
| `src/utils/npmrcLoader.ts` | `npmNpmrcLayers()`: npm's layers, which every adapter without `npmrcLayers` uses                                                                                           |

## `.npmrc` view

- `npmNpmrcLayers(cwd, sources)`, highest first: `npm_config_*` env (any case, `_` → `-`), project, user (`~/.npmrc`), global (`<prefix>/etc/npmrc`), builtin, `${VAR}` expanded everywhere. The project file is the `.npmrc` of the npm project root: from a workspace member, the root's. `loadNpmrc` is its merge
- Unscoped `_authToken` and `always-auth` are ignored, as npm 9+ does
- `emptyRegistry` is npm's `{ registry: true, scopes: false }` (the default for every adapter): npm fails on an empty default and skips an empty scope
- `saveStyle`: `.npmrc` `save-exact` / `save-prefix`. Overrides: npm `overrides` (`src/utils/overrides.ts`)

## Installed versions from the lockfile (#107, #232)

- `installedFromLockfile(root)` answers when the root has `package-lock.json` and no `node_modules` (`readLockedPackages`: a member's nested `<member>/node_modules/<key>` entry first, then the root's `node_modules/<key>`; a `link: true` entry is a member, so linked); with node_modules, node_modules decides. The pipeline logs which lockfile at debug level
- Its `peers` (`LockedInstall.peers`, #232) stands in for `readInstalledPeers` in the plan's peer pass: `readLockedPeers` reads the `peerDependencies` of each `node_modules/<name>` entry (hoisted only, as the node_modules scan reads the root's node_modules; a `link: true` entry through the member entry it resolves to)
- The license pass reads the installed version's manifest from the registry here (`registry.versionManifest(lookupName, current)`), since there is no installed copy

## Release-age gate (#168, probes n01-n11)

`npmReleaseAgeGate`: `min-release-age` in days (fractions allowed) and `before` (an inclusive cutoff, `notAfter`) from its `.npmrc` view, off unless set; `min-release-age-exclude` names and globs, a `name@version` entry exempting nothing. A version with no publish time is let through (`missingTime: 'allowed'`). Cases in `__tests__/releaseAgeGates.test.ts`.

## Engines (#200)

`skipsEnginesExcluded` is true for npm only: npm installs the newest in-range version whose `engines.node` fits its Node (npm-pick-manifest's `engineOk` sort; `npmAcceptsNode` in `src/utils/engines.ts`, which fails an invalid range), probed on npm 12.2.2 and 11.19.1 (they agree; only `--node-version` became an unknown config). npm has no `nodeVersion` hook: it judges by the running Node. pnpm 12.18.0 and bun 1.4.4 install the highest satisfying version whatever the engines (probed 2026-11-07). The plan's walk-back is in `src/utils/plan/CLAUDE.md`.

## Apply

- In-range updates go to `npm update <names>` with no manifest write; npm installs `wanted` and leaves package.json alone
- Writes each manifest in `plan.manifests` that has beyond-range rows, then one `npm update <names>` at the root. No `--workspaces`: that would skip the root's own dependencies, while a root `npm update` moves every workspace's ranges (verified on npm 11.19.1, including a member spec autd just rewrote, so no `install` is needed between)
- npm may leave a row where it was: it dedupes a member's `dayjs` onto the root's pin, and leaves a package another dependency pins exactly; the post-apply check reports `not applied by npm (installed …)`
- Cooldown fallbacks: npm 11.19.1 keeps the locked version when the range comes back, so `pinning` needs no `relock`
- Frozen install in the integration matrix: `npm ci`
