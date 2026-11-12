# Tests

## Overview

Jest with `@swc/jest` as the transform. Tests live in `__tests__/`, mirroring `src/`. The unit suite (`pnpm test`) never touches the network or a real manager; the integration matrix (`pnpm run test:integration`) runs the built CLI against the real managers. Which test covers which module, one line per file, is in `.claude/context/ai-context/project-structure.md`.

## Conventions

- Global setup: `__tests__/setup.ts` (suppresses console output unless `DEBUG` env is set; sets `AUTD_NO_CACHE=1`, so no test touches the developer's cache folder; the integration harness drops it and isolates with `AUTD_CACHE_DIR` in its scratch directory). The integration config loads it too, so the matrix also runs in its empty `HOME`; the bench doesn't load it
- Test timeout: 15 seconds. Uses ESM transform for TypeScript. Mock cleanup: `clearMocks` and `restoreMocks` enabled. Path aliases: `moduleNameMapper` maps `@/*` to `src/*` for test imports
- Single test: `pnpm test -- __tests__/path/to/test.test.ts`. Coverage: `pnpm run test:coverage`; `pnpm run test:badges` regenerates the coverage badges in `./badges`, shown in the README. They are static files: rerun and commit them when coverage changes
- Shared setup helpers (#231) in `__tests__/fixtures/files.ts`: `tempDir`, `write`, `npmrcSources`, `registryConfig`, `localRegistryConfig`. A test never calls mkdtempSync or removes its own directory
- Tests that spawn a fake manager use `writeNodeShim` and `prependPath` from `__tests__/fixtures` (a `sh` wrapper on POSIX, a cmd-shim `.cmd` on Windows); symlinks in tests use type `'junction'`, which Windows allows without privileges. `.gitattributes` keeps every file LF so Windows checkouts match

## Fixtures: real captures, never hand-written

- Manager fixtures under `__tests__/fixtures/<pm>/` are real captures of apply commands and errors (`update`, `upgrade`, berry's `yarn.lock`), read with `readFixture` and `exitError` from `__tests__/fixtures/index.ts`. Discovery tests use registry captures instead: `capturedRegistry(names, { asOf })` for `lookup`, `installPackages` for `node_modules`, with `asOf` the date an expectation was captured so no version drifts. Capture new fixtures from a real run, with local paths scrubbed; never hand-write manager output or registry data
- Registry reader and parser tests serve bodies captured with curl from `__tests__/fixtures/registry/` (its README lists each capture and the checks run); variants come from `derive`, never by hand. Registry client tests run against local HTTP(S) servers and a CONNECT proxy (`__tests__/fixtures/registry.ts`) with committed test-only TLS material in `__tests__/fixtures/tls/` (`generate.sh` regenerates it)
- `singlePackageJson.test.ts` snapshots the single-package check/plan/update JSON documents, identical for all four managers; reviewed once for #106 and regenerated once for #201: never update it to make a change pass
- `--json` documents are validated against the output schema with Ajv (`__tests__/fixtures/outputSchema.ts`; `src/commands/CLAUDE.md`)

## Integration matrix (`__tests__/integration/`, `testRepos/`)

- `pnpm run test:integration` builds, then runs the built CLI against real npm, pnpm, yarn v1, yarn berry and bun on temp copies of `testRepos/<manager>-<layout>`. Needs network access and the managers on PATH (yarn through Corepack: `corepack enable yarn`). Outside `pnpm test` and coverage. `AUTD_INTEGRATION_PM=npm,bun` selects managers (an unknown name fails fast); `AUTD_INTEGRATION_KEEP=1` keeps the temp copies and prints their paths. CI runs it per manager on ubuntu-latest and windows-latest
- `testRepos/<manager>-<layout>/` (see `testRepos/README.md`): small manifests on frozen release lines, no lockfiles. Every fixture manifest (there and in `bench/pinned/`, `bench/ranges/`) is committed as `package.fixture.json` and renamed to `package.json` in the temp copy (`copyProject`), so GitHub's dependency graph raises no Dependabot alerts for versions that are old on purpose
- The harness installs each range at its minimum, restores the ranges, rewrites the lockfile to agree (`lockfiles.ts`, sharing `rewriteYarnV1Lock` / `rewriteBerryLock` with the yarn adapter), then validates every `--json` document the built CLI prints against `schema/output.schema.json` and asserts `check --json` (the same rows as the dry-run), `update --dry-run --json` and `update --json` against values derived from the ranges in `expectations.ts`. It asserts autd's own output, never the manager's. Manager quirks the matrix observes are per-manager overrides there, each with a comment
- In `runMatrix`, every layout's `update --json` is followed by the manager's frozen install (`frozenInstall`: `npm ci`, `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `yarn install --immutable`, `bun install --frozen-lockfile`), which fails if the lockfile disagrees with the manifests
- `runMemberMatrix` repeats every workspace layout from a member: `check --json` from `packages/a` and `packages/a/src` (a config file in `packages/a` with `beyondRange: "patch"`, which moves its pinned `ms` to 2.1.3) and from `packages/b` (no config file there or at the root), berry's `--pm yarn` parity, `update --dry-run --json` from `packages/a` and `packages/b` (`expectedMemberCheck`, `expectedMemberPlan`: a slice of the root's `expectedPlan`; check and plan share both; every manifest and lockfile byte-identical after, `snapshotFiles`), and `update --json` from all three exits 1 with the `apply` refusal naming the root, with no manager on PATH (so nothing ran) and every file keeping its bytes
- `managerEnv` (`harness.ts`) is what isolates the matrix and the bench from a developer's manager config: `npm_config_userconfig` at an empty file, and `XDG_CONFIG_HOME` at its scratch directory, which moves pnpm's global `auth.ini` and `config.yaml` and bun's global bunfig away (#175)

Manager behavior the matrix has observed and asserts:

- pnpm, in a workspace or with catalogs, dedupes the root's `ms` (`~2.1.1`) onto 2.1.2, which a member pins: `pnpm update -r ms` writes `~2.1.2`, and autd reports the row `not applied by pnpm (installed 2.1.2)`
- pnpm and bun raise range floors on `update`; npm, yarn v1 and berry leave package.json alone
- bun 1.4.0 raises floors in package.json but leaves `catalog`/`catalogs` ranges as written; pnpm 12 raises its catalog ranges too
- It caught yarn v1 member devDependencies duplicated into `dependencies` (by `workspace <name> upgrade`, which members no longer run) and bun catalog rows (`catalog (<ws>)`) failing discovery, two autd bugs it found

## CI

CI runs the unit suite on ubuntu and windows, on the `.tool-versions` Node and on 22.23.x, then builds and smoke-tests the bundle (`--version` must equal `package.json`'s version, `help` must run). Biome and the type check run only on ubuntu with the `.tool-versions` Node. The integration matrix runs per manager on ubuntu-latest and windows-latest; the enforced `perf` job is in `bench/CLAUDE.md`. `__tests__/repoConfig.test.ts` guards the coverage config (all four managers measured, only the re-export barrels ignored), the CI workflow, and that every workflow pins each action to a release commit.
