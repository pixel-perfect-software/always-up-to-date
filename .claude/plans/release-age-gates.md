# #168: honor pnpm, bun and npm release-age gates (and berry's, #166)

The rule (the user, 2026-11-03): autd never overrides a package manager's default or configured behavior when it is a security decision on the manager's side. A release-age gate is one: the manager won't install a version younger than the gate, so autd must never propose one.

Each manager's gate becomes `RegistryConfig.releaseAgeGate`, which `withReleaseAgeGate` (`src/utils/releaseAgeGate.ts`, wrapped around the session in `openProject`) applies to every lookup and to `releaseTimes`. So `wanted`, a past-the-range target and a cooldown fallback are all versions the manager installs. A package with nothing let through is left out of discovery with a warning.

## Probes

All run on 2026-11-03. Each manager's `install` of `p-fresh@^1.0.0` ran against a local registry with set publish times. Scripts are in the session scratchpad: `probe-pnpm-age.sh`, `probe-bun-age.sh`, `probe-npm12-age.sh`, `probe-gate.sh` and `probe-pnpm-cli.sh`.

### pnpm 12.16.1

The setting is `minimumReleaseAge`, in minutes. Versions: 1.0.0 (2020), 1.0.1 (2 h ago), 1.0.2 (now).

| Row | Setup                                                   | Installed                                            |
| --- | ------------------------------------------------------- | ---------------------------------------------------- |
| p01 | nothing set                                             | **1.0.0**: one-day default                           |
| p02 | `minimumReleaseAgeExclude: [p-fresh]`                   | 1.0.2                                                |
| p03 | `[ 'p-*' ]`                                             | 1.0.2                                                |
| p04 | `[ p-fresh@1.0.2 ]`                                     | 1.0.2                                                |
| p05 | `[ '@acme/*' ]`, for `@acme/p-fresh`                    | 1.0.2                                                |
| p06 | every version under a day old (1.0.0 at 2 h, 1.0.1 now) | 1.0.0                                                |
| p07 | p06 + `minimumReleaseAgeStrict: true`                   | fails `ERR_PNPM_NO_MATURE_MATCHING_VERSION`          |
| p08 | 1.0.1 has no `time`                                     | 1.0.1: allowed                                       |
| p09 | p08 + `minimumReleaseAgeIgnoreMissingTime: true`        | 1.0.1                                                |
| p10 | `pnpm_config_minimum_release_age=60`                    | 1.0.1                                                |
| p12 | `minimumReleaseAge: 0`                                  | 1.0.2                                                |
| p13 | `minimumReleaseAge: 60` in `pnpm-workspace.yaml`        | 1.0.1                                                |
| p14 | `minimumReleaseAge: 60` in the global `config.yaml`     | 1.0.1                                                |
| p15 | every version young, 1.0.0 now and 1.0.1 2 h ago        | 1.0.0: the lowest satisfying                         |
| p16 | three young versions                                    | 1.0.0                                                |
| p17 | p08 + `minimumReleaseAgeIgnoreMissingTime: false`       | fails `ERR_PNPM_MISSING_TIME`                        |
| p18 | exclude `p-fresh@^1.0.0`                                | fails `ERR_PNPM_INVALID_MINIMUM_RELEASE_AGE_EXCLUDE` |
| p19 | exclude `p-fresh@1.0.1 \|\| 1.0.2`                      | 1.0.2                                                |

The binary also names `minimumReleaseAgeExcludePrune` and `registrySupportsTimeField`; neither changes what is installed.

### bun 1.4.4

The setting is `[install] minimumReleaseAge`, in seconds. Versions as for pnpm.

| Row | Setup                                                | Installed                                              |
| --- | ---------------------------------------------------- | ------------------------------------------------------ |
| b01 | nothing set                                          | 1.0.2: no default                                      |
| b02 | `minimumReleaseAge = 3600`                           | 1.0.1                                                  |
| b03 | `86400` + `minimumReleaseAgeExcludes = ["p-fresh"]`  | 1.0.2                                                  |
| b04 | `["p-*"]`                                            | 1.0.0: not a name to bun                               |
| b05 | `["@acme/*"]`                                        | 1.0.0                                                  |
| b06 | every version young                                  | fails: `blocked by minimum-release-age: 86400 seconds` |
| b07 | 1.0.1 has no `time`                                  | 1.0.1: allowed                                         |
| b08 | `BUN_CONFIG_MINIMUM_RELEASE_AGE=3600`                | 1.0.2: not read                                        |
| b09 | `["p-fresh@1.0.2"]`                                  | 1.0.2                                                  |
| b10 | `3600` in the global `$XDG_CONFIG_HOME/.bunfig.toml` | 1.0.1                                                  |
| b11 | `["p-fresh@1.0.1"]`                                  | 1.0.1: only that version is exempt                     |

### npm 12.2.1

The settings are `min-release-age` (days), `min-release-age-exclude` and `before`. Versions: 1.0.0 (2020), 1.0.1 (3 d), 1.0.2 (2 h), 1.0.3 (now). npm 11.19.1 gave the same answers for `min-release-age` and `before`, and has no exclude list.

| Row | Setup                                      | Installed              |
| --- | ------------------------------------------ | ---------------------- |
| n01 | nothing set                                | 1.0.3: no default      |
| n02 | `min-release-age=1`                        | 1.0.1                  |
| n03 | `=5` + `min-release-age-exclude[]=p-fresh` | 1.0.3                  |
| n04 | `[]=p-*`                                   | 1.0.3                  |
| n05 | `[]=@acme/*`                               | 1.0.3                  |
| n06 | `[]=p-fresh@1.0.2`                         | 1.0.0: exempts nothing |
| n07 | every version young                        | fails `ENOVERSIONS`    |
| n08 | 1.0.1 has no `time`                        | 1.0.1: allowed         |
| n09 | `npm_config_min_release_age=1`             | 1.0.1                  |
| n10 | `before=<2 h ago>`                         | 1.0.2: inclusive       |
| n11 | `min-release-age=0.5`                      | 1.0.1                  |

### yarn berry 4.18.1 (#166, PR #167)

`npmMinimalAgeGate`: a DURATION in minutes, default `1d`, also set per scope. A scope listed in `npmScopes` has its own gate, one day unless set. `npmPreapprovedPackages` takes names or name globs (micromatch) with an optional semver range. A version with no time is held. When nothing is old enough, berry fails. The rows are in `lockfile-discovery.md`.

### yarn v1

No release-age setting.

## The model

`ReleaseAgeGate`:
- `minutes`, and per-scope `scopes` (berry only);
- `exempt`, a list of `ReleaseAgeExemption { name, glob: 'segment' | 'any' | 'none', versions? }`;
- `missingTime`: `held` (berry, and pnpm with `minimumReleaseAgeIgnoreMissingTime: false`) or `allowed`;
- `notAfter`: npm's `before`.

Each manager's syntax maps onto it:
- berry: glob `segment`, range versions;
- pnpm: glob `any`, exact-version unions;
- bun: `none`, an optional exact version;
- npm: `segment`, with no versions. A pattern with `@version` keeps it in its name, so it matches no package.

## Real runs (CLI)

- **berry, p-fresh at 1.0.0, then 1.0.1 (old) and 1.0.2 (now):** `main` proposed 1.0.2, and `update` reported `not applied by yarn (installed 1.0.1)`. The gate branch proposes 1.0.1 and applies it.
- **pnpm 12.16.1, p-fresh at 1.0.0, then 1.0.1 (3 d) and 1.0.2 (now):** `main` (6bd5fa0) proposed 1.0.2, and `update` reported `not applied by pnpm (installed 1.0.1)`. This branch proposes 1.0.1 and applies it. The frozen install passed on both.
