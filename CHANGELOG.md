# Changelog

Notable changes to `@pixel-perfect-software/always-up-to-date`, newest first. Versions before
2.0.0 were published without a changelog.

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
