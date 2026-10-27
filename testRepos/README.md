# testRepos

Fixtures for the integration matrix (`pnpm run test:integration`). Each directory is named
`<manager>-<layout>`: the managers are `npm`, `pnpm`, `yarn` (v1), `berry` (yarn 4) and
`bun`; the layouts are `single`, `workspace` and, for pnpm and bun, `catalogs`.

The suite never runs in these directories. It copies one into the OS temp directory,
installs its dependencies at the lowest version each range allows, restores the ranges,
and runs the built CLI (`dist/index.js`) against the copy. So the checkout stays clean and
the copy sits outside this repository's own pnpm workspace, Biome and git.

Each manifest is committed as `package.fixture.json`, and the copy renames it to
`package.json` (`copyProject` in `__tests__/integration/harness.ts`; `bench/` uses the
same copy). GitHub's dependency graph reads every `package.json` in the repository, and
these pin old versions on purpose, so under their real name they raised Dependabot alerts.
`exclude-paths` in `.github/dependabot.yml` only stops update pull requests, not alerts.
Edit a fixture's `package.fixture.json`, never a `package.json` here.

## Rules for the dependency lines

The sets are frozen on purpose: they must resolve the same way for as long as possible.

- Only `^`, `~` or exact versions. The harness refuses any other spec.
- No dependency, direct or transitive, runs install scripts.
- No advisories. Never `semver` below 7.5.2 or `lodash` below 4.17.21. `chalk` and `debug`
  stay on lines that exclude the September 2025 malicious releases.
- Lockfiles are generated in the temp copy and never committed (`.gitignore` covers them).

Frozen maxima: chalk 4.1.2, commander 11.1.0, debug 4.3.7, kleur 3.0.3, ms 2.1.3. Each
package appears in at most two manifests, never at the same installed version. `dayjs` is
an exact pin at the root only, and `ms` is `~2.1.1` at the root beside `2.1.2` in `@autd/a`.

## Running

```sh
pnpm run test:integration                              # every manager
AUTD_INTEGRATION_PM=npm,bun pnpm run test:integration  # a comma-separated selection
AUTD_INTEGRATION_KEEP=1 pnpm run test:integration      # keep the temp copies (paths on stderr)
```

It needs network access and these on `PATH`: npm and pnpm (as set up for development), bun
at the version in `.tool-versions`, and yarn through Corepack (`corepack enable yarn`), which
picks 1.22.22 or 4.12.0 from each repo's `packageManager`.
