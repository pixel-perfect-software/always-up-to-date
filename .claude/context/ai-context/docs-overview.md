# Documentation Registry

Tier 1 is project-wide and always loaded. Tier 2 and 3 files load on their own when you work under their directory; reference files load only when you read them. This list exists so you can find them before you start.

## Size caps

- Root `CLAUDE.md` plus what it imports (this file): under 20 KB together. The root holds the overview, one line per command, the invariants, a one-line-per-module map and this import
- Each Tier 2 `CLAUDE.md`: under 12 KB
- Each Tier 3 `CLAUDE.md`: about 150 lines (the project-context template's rule for nested files); move reference-grade detail beside it, linked, past that
- Reference files: no cap, but nothing `@`-imports them; each is linked from the doc of the code it describes with a one-line "read when"

Over a cap, move detail down a tier or into a reference file; never drop a verified fact (a probe ID, a dated "verified on", an issue reference, a precedence order, a decision's reason).

## Tier 1 — Foundational

- `CLAUDE.md` — overview, commands, invariants, module map
- `.claude/context/ai-context/docs-overview.md` — this registry (imported by `CLAUDE.md`)
- `.claude/context/ai-context/pipeline.md` — reference: the pipeline, `openProject`, detection, native discovery, installed versions, member runs, the command runner. Read before changing any file directly under `src/`
- `.claude/context/ai-context/project-structure.md` — reference: the tree with a note per test file, tech stack, build and type-check detail, releasing, engines. Read before adding a directory or a test file

## Tier 2 — Component

- `__tests__/CLAUDE.md` — test conventions, real-capture fixtures, the integration matrix and what it observed, CI
- `bench/CLAUDE.md` — `pnpm run bench`, its environment variables and document, `bench:gate` budgets and retries, the CI `perf` job
- `src/commands/CLAUDE.md` — definitions and actions, lazy startup and its guards, options, the `--json` document, failures
- `src/managers/CLAUDE.md` — the adapter interface, adding a manager, workspace detection and the member map, apply, cooldown pins
- `src/utils/CLAUDE.md` — config, logger, installed versions, specs and the other shared helpers; links its reference files

## Tier 3 — Feature

- `src/managers/bun/CLAUDE.md` — bun's `.npmrc` layers, bunfig.toml routes and credentials, release-age gate, catalogs, apply
- `src/managers/npm/CLAUDE.md` — npm's `.npmrc` layers, `package-lock.json` installs and peers, release-age gate, engines preference, apply
- `src/managers/pnpm/CLAUDE.md` — `pnpm-workspace.yaml` as one reader, pnpm 12's layers and global directory, release-age gate, apply
- `src/managers/yarn/CLAUDE.md` — v1 `.npmrc`, credentials and `.yarnrc`; berry `.yarnrc.yml`, release-age gate, `yarn.lock` discovery; both applies and relocks
- `src/utils/plan/CLAUDE.md` — the update policy, cooldown, and every plan pass in order, with `splitUpdates`

## Reference (read when named)

- `src/utils/MANIFESTS.md` — spec shapes, manifest and catalog writers, save style. Read before changing a writer
- `src/utils/OUTPUT.md` — the human report's sections and notes, reasons, `--json` rows. Read before changing the report or a reason
- `src/utils/REGISTRY.md` — `.npmrc` layers, `RegistryConfig`, the session, client, lookup, publish times, version manifests, disk cache, release-age gate, redaction. Read before changing anything that reads registry settings or asks a registry
- `docs/contributing.md` — for human contributors: setup, scripts, workflow, adding a manager
- `docs/roadmap.md` — milestones and their issues
