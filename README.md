<p align="center">
  <img src="assets/logo.svg" width="128" height="128" alt="Always Up To Date logo: an npm package box with an automation gear" />
</p>

<h1 align="center">Always Up To Date</h1>

<p align="center">
  Dependency updates that respect your package.json: ranges are followed, exact pins stay put, and you decide how far past them to go.
</p>

<p align="center">
  <a href="https://github.com/pixel-perfect-software/always-up-to-date/actions/workflows/ci.yml"><img src="https://github.com/pixel-perfect-software/always-up-to-date/actions/workflows/ci.yml/badge.svg?branch=main" alt="CI" /></a>
  <a href="https://www.npmjs.com/package/@pixel-perfect-software/always-up-to-date"><img src="https://img.shields.io/npm/v/@pixel-perfect-software/always-up-to-date?label=npm%20package&color=cb3837" alt="Latest version on npm" /></a>
  <img src="https://img.shields.io/node/v/@pixel-perfect-software/always-up-to-date?color=339933" alt="Node.js version" />
  <img src="https://img.shields.io/badge/managers-npm%20%7C%20pnpm%20%7C%20yarn%20%7C%20bun-4C6EF5" alt="Package managers: npm, pnpm, yarn and bun" />
  <img src="https://raw.githubusercontent.com/pixel-perfect-software/always-up-to-date/main/badges/badge-lines.svg" alt="Coverage: lines" />
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue.svg" alt="License: MIT" /></a>
</p>

`autd` updates your dependencies the way your package manager would. Run `autd update` and each
dependency moves to the newest version its package.json range allows, the same set `npm update`
installs, while an exact pin like `"18.2.0"` stays exactly where it is. When you want more, a
small config file lets one package, a scope, or everything move past its range.

It works with npm, pnpm, yarn and bun, in single projects and workspaces, and uses the package
manager your package.json declares, or the one your lockfile belongs to.

```console
$ autd update --dry-run

Would update (16 packages)
  axios       1.4.0   → 1.20.0   within range
  commander   9.0.0   → 9.5.0    within range
  debug       4.3.1   → 4.3.7    within range
  zod         3.20.0  → 3.25.75  within range; 3.25.76 released 1d ago, needs 2d
  …

Held by cooldown (1 package)
  ms          2.1.2   → 2.1.3    released 1d ago, needs 2d

Past the range in package.json (5 packages)
  express     4.17.1  → 5.3.0    major; "beyondRange": "major" would move it
  react       18.2.0  → 19.3.1   major; "beyondRange": "major" would move it
  typescript  5.0.4   → 7.0.2    major; "beyondRange": "major" would move it
  …

16 to update · 1 held by cooldown · 5 past the range
```

`check` prints the same report, and `update` prints it once more after the package manager has run, with what it actually installed. Every package shows up once, under what happened to it: updated, left in place by the package manager, held by cooldown, past its range, or held by a rule, an override or a peer conflict.

What happens to each kind of spec:

| In package.json | Installed | Latest | `autd update`             | With `"beyondRange": "major"` |
| --------------- | --------- | ------ | ------------------------- | ----------------------------- |
| `"^9.0.0"`      | 9.0.0     | 15.0.0 | 9.5.0, the newest `9.x`   | `"^15.0.0"`                   |
| `"~4.3.1"`      | 4.3.1     | 4.4.3  | 4.3.7, the newest `4.3.x` | `"~4.4.3"`                    |
| `"18.2.0"`      | 18.2.0    | 19.3.1 | stays on 18.2.0           | `"19.3.1"`, still exact       |

## ✨ Features

- 📏 **Follows your ranges.** By default an update installs what the package manager itself would, and an exact pin is never touched.
- 🎚️ **Goes further when you say so.** `beyondRange` lets everything move past its range by a patch, minor or major step; per-package `rules` hold a package, keep it in range, or always take the latest, by name or `*` glob.
- 🛡️ **Holds what would break.** A package your package manager pins with an override is left alone, and so is an update an installed package's peer range would reject. Each one is reported with the reason.
- ⏳ **Waits out fresh releases.** `cooldown` skips versions published more recently than a number of days, a duration like `"1 week"`, or a limit per update type.
- ✍️ **Keeps package.json yours.** Decorators, `npm:` aliases and compound ranges keep their shape, and the file keeps its indentation, line endings and final newline.
- 🤖 **Fits in CI.** `--json` prints nothing but JSON, and a failed step exits 1 with its name.

## 📋 Requirements

- **Node.js** 22.23 or later on 22, or 24.17 or later
- **npm**, **pnpm**, **yarn** (v1, or 2+ with the PnP or `node-modules` linker) or **bun**.

## 🚀 Install

```bash
npm install -g @pixel-perfect-software/always-up-to-date
```

The command is `autd`; `alwaysuptodate` and `always-up-to-date` work too.

## 🧭 Getting started

```bash
autd check              # list outdated dependencies
autd update --dry-run   # see where each one would move, or why it's held
autd update             # apply it
autd init               # optional: create .always-up-to-date.json to go past your ranges
```

## ⌨️ Commands

| Command                                                   | Description                                                                            |
| --------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `autd check`                                              | List outdated dependencies                                                             |
| `autd check --json`                                       | The same, as JSON                                                                      |
| `autd update`                                             | Update every eligible dependency                                                       |
| `autd update [packages...]`                               | Update only the named packages                                                         |
| `autd update --dry-run`                                   | Show where each package would move, or why it's held, without changing anything        |
| `autd update -i, --interactive`                           | Pick the packages to update from a checklist                                           |
| `autd update --json`                                      | Print the update results as JSON (combines with `--dry-run`, not with `--interactive`) |
| `autd check --no-cache`, `autd update --no-cache`         | Ask the registries instead of using autd's cache (see [Cache](#-cache))                |
| `autd check --pm <manager>`, `autd update --pm <manager>` | Use `npm`, `pnpm`, `yarn` or `bun` instead of detecting the manager                    |
| `autd init`                                               | Create `.always-up-to-date.json` in the current directory                              |
| `autd help`                                               | Show help                                                                              |

## ⚙️ Configuration

You only need a config file to go further than your package.json ranges. Run `autd init` to create
`.always-up-to-date.json` in your project root (from a workspace member, its own file if it has one, else the workspace root's):

```json
{
  "beyondRange": "none",
  "rules": {},
  "cooldown": 0,
  "debug": false,
  "silent": false
}
```

| Option        | Default  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `beyondRange` | `"none"` | How far past its range a dependency may move, to its latest version: `"none"`, `"patch"`, `"minor"` or `"major"`. Applies to exact pins too, so `"patch"` moves `"1.11.9"` to `"1.11.23"`.                                                                                                                                                                                                                                                  |
| `rules`       | `{}`     | Per-package overrides (see below).                                                                                                                                                                                                                                                                                                                                                                                                          |
| `cooldown`    | `0`      | Skip versions published more recently than this: days (`7`), a duration (`"1 week"`, `"24h"`), or per update type (`{ "major": "30 days" }`). A package whose newest version is too fresh moves to the newest one that is old enough and that its range in package.json allows, and is held only when there is none. A version whose publish date can't be found is held too.                                                               |
| `depsDev`     | `true`   | Look up versions of packages on the public npm registry (registry.npmjs.org, registry.yarnpkg.com) through [deps.dev](https://deps.dev), which is much smaller than the registry's own documents. Each such package name is sent to api.deps.dev, **including private packages published to registry.npmjs.org**; set `false` to read everything from the registry. Names from any other registry, including a scope's own, are never sent. |
| `debug`       | `false`  | Print each package-manager command and its stderr.                                                                                                                                                                                                                                                                                                                                                                                          |
| `silent`      | `false`  | Suppress all output.                                                                                                                                                                                                                                                                                                                                                                                                                        |

### Rules

`rules` overrides the policy for single packages or groups:

```json
{
  "beyondRange": "minor",
  "rules": {
    "react": "hold",
    "typescript": "latest",
    "@types/*": "followRange"
  }
}
```

| Rule            | Effect                                                              |
| --------------- | ------------------------------------------------------------------- |
| `"hold"`        | Never update this package.                                          |
| `"followRange"` | Stay within the range, even when `beyondRange` allows more.         |
| `"latest"`      | Always move to the latest version, whatever the range or step size. |

Keys are package names or `*` globs (`"@types/*"`, `"eslint-*"`, `"*"`). An exact name beats a glob, and among globs the longest pattern wins.

### What else holds an update

- **Installed peer ranges.** An update an installed package's peer range would reject is held, naming that package: `react` stays on 18 while `@tanstack/react-query` 4, which accepts react up to 18, stays installed. A `"latest"` rule still moves it, with a warning.
- **Overrides.** A package your package manager pins with an override is held when the update would leave the override's range, with the reason `controlled by …`. That covers npm `overrides`, yarn berry `resolutions`, pnpm `overrides` in `pnpm-workspace.yaml`, and bun `overrides` or `resolutions`.

### How specs are rewritten

When a dependency moves past its range, its spec keeps its decorator: `"^18.2.0"` becomes `"^19.3.1"` and `"1.11.9"` becomes `"1.11.23"`. A spec that can't keep its shape, such as `"3.x"` or `">=4 <5"`, is written the way your package manager writes a new dependency: `^` unless you set `save-exact` / `save-prefix` (npm), `saveExact` / `savePrefix` (pnpm), `defaultSemverRangePrefix` (yarn) or `exact` (bun).

## 📦 Package managers and workspaces

autd uses the first of these that names a manager: the `--pm` option, the `packageManager` field in package.json (`"pnpm@12.14.0"`, as Corepack reads it), `devEngines.packageManager`, then the lockfile. A lockfile from another manager than the declared one is ignored, with a warning when the declared manager has no lockfile of its own. With several lockfiles and nothing declared, autd warns and picks in the order bun, pnpm, yarn, npm.

| Manager          | Lockfile            | Workspaces from                                                  |
| ---------------- | ------------------- | ---------------------------------------------------------------- |
| npm              | `package-lock.json` | the `workspaces` field in package.json                           |
| pnpm             | `pnpm-lock.yaml`    | the `packages` list in `pnpm-workspace.yaml`, including catalogs |
| yarn (v1 and 2+) | `yarn.lock`         | the `workspaces` field in package.json                           |
| bun              | `bun.lock`          | the `workspaces` field in package.json, including catalogs       |

In a workspace, autd plans each package once per manifest that declares it, and `update --json` has one row per package and manifest, each with a `workspace` (`.` is the root). A package that moves past its range is rewritten in the manifest that declares it; if that spec is a `catalog:` reference, the catalog entry is rewritten instead. A package that can move in one manifest but is held in another (a cooldown, a peer conflict, an override) is held everywhere, with the reason `held with <path> (…)`, so the manifests don't drift apart.

### Running from a workspace member

Run `check` or `update --dry-run` from a member's directory (or any directory inside it) and autd covers that member's manifest only. It finds the workspace root that lists the member, so the manager is detected as it would be at the root, and `check --json` lists only that member's packages. The config is the member's own `.always-up-to-date.json` if it has one, else the workspace root's; the two are not merged. A pnpm directory with its own `pnpm-workspace.yaml`, or one no workspace lists, is a project of its own. Yarn 2+ refuses a directory its root doesn't list, and so does autd.

`update` is refused from a member. Every manager writes one lockfile for all workspaces and can move other workspaces' copies of a package, so an update is never limited to one member. Run `autd update` in the workspace root; `autd update --dry-run` in the member previews that member's updates.

## 🗄️ Cache

autd keeps what it learns from the registries (each package's latest version and the list of its versions) so a second `check` within five minutes asks nobody. The folder is `ca.pixel-perfect.alwaysuptodate` in:

- `~/Library/Caches/` on macOS
- `$XDG_CACHE_HOME` if it is an absolute path, else `~/.cache`, on Linux and other Unixes
- `%LOCALAPPDATA%` on Windows

It holds derived version lists only, never a registry document, a header or anything about your credentials. Latest versions are kept for 5 minutes and deps.dev lists for an hour; a registry's own `Cache-Control` can shorten that. A stale package document is checked with the registry (`If-None-Match`) rather than downloaded again. An answer from a registry you authenticate to is reused without asking only when the package is also public on deps.dev; otherwise autd asks the registry each time (a cheap `304` when nothing changed). The folder stays under 32 MiB, dropping the least recently used entries.

- `--no-cache` on `check` or `update`, or `AUTD_NO_CACHE` set to anything but empty, `0` or `false` (`1` and `true` both work), reads and writes nothing.
- `AUTD_CACHE_DIR=<path>` puts the folder somewhere else; autd only writes inside its `v1/` subfolder.
- Deleting the folder is always safe.

## 🩺 Troubleshooting

- **A package isn't updating.** Run `autd update --dry-run`: every held package shows why, such as `major beyond the range`, `held by rule`, `controlled by overrides (…)` or `peer conflict: …`. After `autd update`, a package your manager was asked to move but left where it was is listed under "left in place by …" and reported with `"updated": false` and `not applied by npm (installed …)`. npm does this to a package another dependency pins exactly, and to a workspace member's copy it dedupes onto the root's. In a workspace, `held with <path> (…)` means the same package is held in that manifest, so its other manifests wait for it.
- **`check` or `update` exits 1.** The message names the step that failed (`detect`, `discover` or `apply`) and says whether package.json was already written. Set `"debug": true` to see each package-manager command and its stderr.
- **"No package manager detected".** package.json declares no manager and there's no lockfile in the current directory (from a workspace member: in the member's package.json or between it and the workspace root, nor a lockfile in the workspace root). Set `"packageManager"`, pass `--pm`, or run your package manager's install first.
- **`cooldown` holds a package with `release date unknown`.** autd couldn't read that version's publish time from the registry. It reads `.npmrc` the way npm does: registries and scoped registries, per-registry auth, `ca` / `cafile` / `strict-ssl`, `https-proxy` / `proxy` / `noproxy`, `fetch-retries`, `fetch-timeout` and `maxsockets`. SOCKS proxies aren't supported. Set `"debug": true` to see the request that failed.
- **The wrong package manager runs.** A leftover lockfile decided it. Set `"packageManager"` in package.json or pass `--pm`; with `"debug": true`, autd logs which lockfiles it ignored.

## 🔄 Upgrading from 1.x

2.0 changed what `autd update` does with no config. 1.x moved any dependency with a newer patch release, rewriting exact pins to `^`, and held minor updates even when the range allowed them. 2.0 installs what the range allows and leaves exact pins alone. To let pins take patch releases again, set `"beyondRange": "patch"`.

Old config files keep working. When both are set, `beyondRange` and `rules` win:

| Old field                   | Same as                      |
| --------------------------- | ---------------------------- |
| `"allowMinorUpdates": true` | `"beyondRange": "minor"`     |
| `"allowMajorUpdates": true` | `"beyondRange": "major"`     |
| `"updateAllowlist": ["x"]`  | `"rules": { "x": "latest" }` |
| `"updateDenylist": ["x"]`   | `"rules": { "x": "hold" }`   |

See [CHANGELOG.md](CHANGELOG.md) for everything in each release, and the [roadmap](docs/roadmap.md) for what's next.

## 🤝 Contributing

Contributions are welcome! See the [Contributing Guide](docs/contributing.md) to get started.

## 💸 Support this project

<a href="https://www.buymeacoffee.com/tylernrobertson" target="_blank"><img src="https://cdn.buymeacoffee.com/buttons/v2/default-blue.png" alt="Buy Me A Coffee" height="50" width="217" /></a>

## 📝 License

MIT © [Tyler Robertson](https://github.com/TylerNRobertson) @ [Pixel Perfect Software Inc.](https://github.com/pixel-perfect-software). See [LICENSE](LICENSE) for details.
