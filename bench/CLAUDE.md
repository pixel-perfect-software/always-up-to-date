# Benchmark and perf gate

## Overview

`pnpm run bench` is the benchmark behind the roadmap's perf gates; `pnpm run bench:gate` (#110) is the pass/fail wrapper CI's `perf` job runs. macOS and Linux only; outside `pnpm test` and coverage.

## Key Files

| Path                 | Role                                                                                                                                                                                                                                                            |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pinned/`, `ranges/` | The 40-dependency benchmark manifests, committed as `package.fixture.json` (renamed to `package.json` in the temp copy, so GitHub's dependency graph raises no Dependabot alerts for versions that are old on purpose)                                          |
| `run.ts`             | Copy, install, hyperfine, the moving-rows guard, the untimed debug run for full packuments, three tables, the `AUTD_BENCH_JSON` document                                                                                                                        |
| `targets.ts`         | Selection, `startupMode`, `jsonPathFrom`, cold caches (`coldCaches`), `MOVING_CONFIG` / `COOLDOWN_CONFIG`                                                                                                                                                       |
| `report.ts`          | hyperfine JSON parsing, the `BenchDocument` types and `parseBenchDocument`, `medianDifference`, `fullPackumentReads`, `formatDifference`, `movingRows` (the rows with outcome `update` of a v1 document; a 3.x array still reads, for `AUTD_BENCH_CLI`), tables |
| `budgets.ts`         | Pure: `BUDGETS`, `legFrom`, `attemptOf`, `nextStep`, `verdictOf`, `exitCodeOf`, `annotationsOf`, `renderSummary`                                                                                                                                                |
| `gate.ts`            | `runGate` with injected `runBench` / `sleep` / `writeSummary` / `log`; the real spawn of `run.ts` and the entry point                                                                                                                                           |
| `register.cjs`       | swc loader for `run.ts` and `gate.ts`; maps the `@/*` path aliases itself; it also hands `.ts` entry points that Node's ESM loader starts (the package is `"type": "module"`) back to the CommonJS loader through a `module.registerHooks` load hook            |

## `pnpm run bench`

- Builds, copies `bench/pinned/` (40 dependencies, each an exact old version; the baseline project) to a temp dir per manager, installs it, then times with hyperfine 2+ (needs it on PATH, plus network and Corepack for yarn) and prints three tables: per manager, `check` warm and cold (the manager's own cache emptied before each run) with the warm peak memory; the cooldown rows; then `autd --version` against bare `node -e 0`
- Rows: npm, pnpm, yarn v1, yarn berry under PnP (`berry`) and with the node-modules linker (`berry-nm`), bun
- The cooldown rows run on a project whose rows move, because `bench/pinned/` pins every dependency exactly and the default policy holds exact pins, so no row would reach the cooldown gate: after the cold row the bench writes `MOVING_CONFIG` (`{ "beyondRange": "major" }`, so the pinned dependencies move to `latest`, bar the few a peer conflict holds; `bench/targets.ts`) and times `check` cold (`moving, cold`), then `COOLDOWN_CONFIG` (`MOVING_CONFIG` plus `cooldown: 7`) cold and warm
- The second table lists `targets` (the rows `update --dry-run --json` plans to move under `MOVING_CONFIG`; a guard fails the manager's row when there are none, since the cooldown rows would measure nothing), `moving, cold`, `cooldown 7, cold`, the cooldown overhead, cold (the median of `cooldown 7, cold` minus the median of `moving, cold`, so `beyondRange`'s own planning cost cancels out; two independently taken medians, since the runs are not paired, and negative when the cooldown row is the faster), `cooldown 7, warm`, and the peak memory of the two cold rows
- After `cooldown 7, warm` each row makes one more cold `check` under `COOLDOWN_CONFIG` plus `debug: true`, untimed and outside every hyperfine measurement (the caches emptied first), and `fullPackumentReads` (`bench/report.ts`) lists the packages whose `Reading the full packument of <name> for publish times` line (#176, logged only when a body came back) it printed: the `full packuments:` line under the second table, and `fullPackuments` in the document. That run only attributes a slow day (deps.dev lagging on a package): when it fails the bench logs a line, the row keeps its numbers and `fullPackuments` is absent
- The startup table (`autd --version`, `node -e 0`, difference) shows the mean and the median, and its difference is the difference of medians (`medianDifference`, `bench/report.ts`); each is `STARTUP_RUNS` (80) timed runs after 3 warm-ups
- A manager that fails is shown as a failed row, its error printed under the tables, and the exit code is 1
- A run a host throttled timed a fallback, not the row (#174): every `check` runs under hyperfine's `--show-output` (+0.1% on a warm `check`, measured 2026-11-05; `--output=<file>` keeps only the last run's), and the first measurement where autd printed `Throttled by …` stops that manager, whose row shows `throttled` with no numbers, the line under the tables and exit code 1
- What cold empties is `coldCaches` in `bench/targets.ts`, autd's own cache included (`AUTD_CACHE_DIR` into the bench's temp root, one folder per row)
- Isolation: `managerEnv` (`__tests__/integration/harness.ts`) points `npm_config_userconfig` at an empty file and `XDG_CONFIG_HOME` at its scratch directory, which moves pnpm's global `auth.ini` and `config.yaml` and bun's global bunfig away (#175). A token in `auth.ini` takes a different cache path, so a pnpm row would measure something npm's and bun's don't. In the bench, `~/.yarnrc.yml` still applies: only `HOME` moves it, which moves Corepack's cache too. The bench doesn't load `__tests__/setup.ts`

### Environment

- `AUTD_BENCH_PM=npm,bun` selects rows (an unknown name fails fast)
- `AUTD_BENCH_RUNS=n` sets the timed runs of each `check` measurement
- `AUTD_BENCH_CLI=/path/to/other/dist/index.cjs` times another build, so a branch can be compared with `main`
- `AUTD_BENCH_PROJECT=ranges` uses `bench/ranges/` (12 of the 40 on `^`/`~`)
- `AUTD_BENCH_JSON=<path>` also writes the machine-readable document (`BenchDocument` in `bench/report.ts`, read back by `parseBenchDocument`: `version: 1`, the autd version, Node, platform, arch, project, one row per target with `status` `measured` (every timing's mean, stddev, median, runs and peak memory, `targets`, `fullPackuments`), `failed` or `throttled` (an `error` and no numbers), and `startup` as `measured` or `failed`), against the cwd, in a folder that must exist, and written before the tables are printed even when rows failed
- `AUTD_BENCH_STARTUP=only|skip` times only startup (no manager is installed or measured, and the tables of rows are not printed) or leaves it out; an unset or blank value times both, and a bad value fails fast like `AUTD_BENCH_RUNS`
- `AUTD_BENCH_KEEP=1` keeps the temp copies and prints their paths

## `pnpm run bench:gate` (#110)

- One leg per `AUTD_BENCH_GATE_TARGET` (`startup` or a target; anything else fails before a measurement): `bench/gate.ts` spawns a fresh `bench/run.ts` per attempt (`AUTD_BENCH_STARTUP=only`, or `AUTD_BENCH_PM=<target>` with `skip`, each attempt its own `AUTD_BENCH_JSON` in a temp folder), ignores that process's exit code and reads the document, up to 3 attempts, appends one summary to `GITHUB_STEP_SUMMARY` (stdout when unset), and exits 0 passed, 1 over budget, 2 failed, 3 throttled and inconclusive (red, labelled "not a budget failure")
- `bench/budgets.ts` (pure) holds the budgets (`check` cold under 1 s and warm under 0.3 s, cooldown overhead cold under 0.5 s, startup over bare node under 25 ms; medians, "under" strict, no margin), `attemptOf` (a missing or unparseable document, a missing row or a timing with fewer than 3 runs is `failed`), `nextStep` (over: wait 30 s and measure again; throttled: wait 60 s then 120 s; failed: one retry after 30 s) and `verdictOf` (a budget's value is the lower of its medians across measured attempts, so it fails only if over on both)
- Under GitHub Actions the gate wraps the bench's output in `::stop-commands::`, because a row's error text comes from a manager and reaches the log; annotations and the summary carry only our own numbers, and the summary's fenced error block neutralises a leading `::`

## CI `perf` job

Runs `pnpm run bench:gate` on ubuntu-latest, one leg per `AUTD_BENCH_GATE_TARGET` (`startup`, npm, pnpm, yarn, berry, berry-nm, bun; 20-minute timeout, no secrets or registry token), with hyperfine 2.0.0 installed from its release tarball and checked against `HYPERFINE_SHA256` (apt has 1.18; Dependabot cannot update the pin, so version and digest are bumped together by hand). The measure step has no `continue-on-error` (`__tests__/repoConfig.test.ts` fails if it comes back), so the job is enforced: a budget confirmed over, a failed measurement or a throttled one turns the leg red, a throttled one labelled inconclusive rather than a budget failure (Re-run failed jobs is the remedy), and the summary names the budget and the amount. It is not a required check: that is a GitHub branch-protection setting, the maintainer's. A last step fails the leg if the bench left the checkout changed.

## Testing Considerations

`__tests__/bench/` covers the pure parts: `report.test.ts` on real hyperfine 2 JSON and `--show-output` captures, `parseBenchDocument` on the real document (`__tests__/fixtures/bench/document.json`, an `AUTD_BENCH_PM=npm` run, npm 11.19.1 on macOS arm64) and damaged variants from `structuredClone`, and `fullPackumentReads` on the real debug capture (`check-debug.txt`); `budgets.test.ts` each budget at, below and above its limit; `gate.test.ts` runs `runGate` with a fake `runBench` and `sleep` (the 30, 60 and 120 s waits and exit codes, no real sleeping).
