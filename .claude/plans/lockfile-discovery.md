# #107: installed versions from lockfiles; yarn berry on native discovery

Issue: #107 (M3). Done when:
- `check` on berry (PnP and node-modules linker) runs no `yarn` command and takes under 1 s cold on the benchmark;
- an npm workspace without `node_modules` lists its members' rows.

Three PRs, each off `main`:

| PR  | Scope                                                                                                                                                | Depends on                                     | State   |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ------- |
| A   | npm: `package-lock.json` installed versions when the root has no `node_modules` (`ManagerAdapter.installedFromLockfile`, `readLockedPackages`)       | none                                           | PR #164 |
| B   | berry: `.yarnrc.yml` registry settings for the session (routes, auth, network); berry stops reading `.npmrc`                                         | none (fixes berry cooldown lookups on its own) | next    |
| C   | berry: `yarn.lock` reader, berry onto `discoverFromRegistry` (drop `ownDiscovery`, `discoverBerry`, `yarn npm info`); `installed()` from `yarn.lock` | B                                              | after B |

Then: bench rows for berry and berry-nm (cold under 1 s), and the roadmap entry.

## Decisions

- **pnpm, yarn v1 and bun keep #106's failure** ("Nothing is installed … run `<pm> install`") without `node_modules`. The issue's "report no current" predates #106, and the issue scopes lockfile reading to berry and npm.
- **npm reads the lockfile only when the root has no `node_modules`.** With one, `node_modules` decides, including `missing`.
- **No new dependency for `.yarnrc.yml`:** a YAML-subset reader, as for `.npmrc` and pnpm's yaml routes. Check it against `yarn config get <key> --json`.
- **Berry gets its own auth rule** (`RegistryConfig.berryAuth`, beside `yarnV1Auth`), applied by the client.

## Berry 4.18.1 behavior

Probed 2026-11-03 with `yarn install --mode=skip-build` (Corepack, offline). Local registries A (4901) and B (4902) logged the packument request's `Authorization`; C (4903) redirects to `localhost:4902`, D (4904) to `127.0.0.1:4902`. Scripts: the session scratchpad's `probe126/probe-berry.sh`, `berry-cases.sh` and `berry-cases2.sh`.

| Row             | Setup                                                                                | Sent                                              |
| --------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------- |
| r01             | unscoped, `npmRegistryServer: B`, `npmAuthToken: T`                                  | none                                              |
| r02             | r01 + `npmAlwaysAuth: true`                                                          | Bearer T                                          |
| r03             | `@acme`, `npmScopes.acme: {npmRegistryServer: B, npmAuthToken: S}`                   | Bearer S                                          |
| r04             | `@acme` routed to B by its scope, top-level `npmAuthToken: T` only                   | Bearer T                                          |
| r05             | unscoped, `npmRegistries."//127.0.0.1:4902".npmAuthToken: R`                         | none                                              |
| r06             | r05 + that entry's `npmAlwaysAuth: true`                                             | Bearer R                                          |
| r07             | `@acme` to B, `npmRegistries."http://…4902".npmAuthToken: R`, top-level T            | Bearer R                                          |
| r08 / r09       | scope `npmAuthIdent: "u:p"` / its base64                                             | Basic base64(u:p), both                           |
| r10             | `@acme` on the default registry B, top-level T                                       | Bearer T                                          |
| r11             | `.yarnrc.yml` A, `YARN_NPM_REGISTRY_SERVER=B`                                        | asks B                                            |
| r12             | `YARN_NPM_AUTH_TOKEN=E` + `npmAlwaysAuth`                                            | Bearer E                                          |
| r13             | project B, `~/.yarnrc.yml` A                                                         | asks B                                            |
| r14             | project none, parent B, home A                                                       | asks B                                            |
| r15             | home `npmScopes.acme.npmAuthToken: H`, project `npmScopes.acme.npmRegistryServer: B` | Bearer H (maps merge per key)                     |
| r16 / r17 / r18 | `npmAuthToken: "${TOK}"` set / `"${UNSET:-D}"` / `"${UNSET}"`                        | Bearer V / Bearer D / run fails, no request       |
| r19             | `.npmrc` `@acme:registry=B` + its token, `npmRegistryServer: A`                      | asks A: `.npmrc` is ignored                       |
| r21             | unscoped, entry R without `npmAlwaysAuth`, top-level `npmAlwaysAuth: true`           | none                                              |
| r22             | unscoped, entry with `npmAlwaysAuth` and no token, top-level T                       | fails: "No authentication configured for request" |
| r23             | entry key with a trailing slash                                                      | matches (Bearer R)                                |
| r24             | scope token S and an entry token R for the same registry                             | Bearer S                                          |
| r25 / r26       | scope registry C / D (a redirect), scope token S                                     | first hop S; B none on both                       |
| r27             | `HTTP_PROXY` / `HTTPS_PROXY` set to a dead proxy                                     | B reached directly: env proxies ignored           |
| r28             | scope registry `B/npm`, entry `//127.0.0.1:4902`                                     | none: no walk up the path                         |
| r29             | `YARN_NPM_ALWAYS_AUTH=true` + top-level T                                            | Bearer T                                          |
| r30             | `npmRegistryServer: B/`, entry `B/` token R, top-level `npmAlwaysAuth`               | none (the entry's own `npmAlwaysAuth` decides)    |

The rule, as these rows show:
1. **The configuration that answers:** the scope's, if it holds `npmAuthToken` or `npmAuthIdent`; else the `npmRegistries` entry for the request's registry (exact after dropping a trailing `/`, then without the protocol); else the top level.
2. **Whether it is sent:**
   - a scoped package sends whatever that configuration holds;
   - an unscoped package sends only when that configuration's own `npmAlwaysAuth` is true. An entry doesn't inherit the top level's (r21, r30). With `npmAlwaysAuth` and no credential, berry fails the run (r22).
3. **The header:** `Bearer <token>`; `npmAuthIdent` is `Basic base64(ident)` when it holds `:`, else `Basic <ident>` as written.
4. **Redirects:** the header goes to the first hop's origin only (r26: same hostname, other port, dropped).

Files and settings:
- **Files:** `.yarnrc.yml` in the project directory and every parent, nearest first, then `~/.yarnrc.yml`. Per key the nearest wins; maps (`npmScopes`, `npmRegistries`) merge per entry and per key.
- **Environment:** `YARN_<SETTING>` overrides the files, e.g. `YARN_NPM_REGISTRY_SERVER`, `YARN_NPM_AUTH_TOKEN`, `YARN_NPM_ALWAYS_AUTH`.
- **`${VAR}` substitution:** `${VAR:-x}` works; an unset `${VAR}` fails the run.
- **Settings defaults** (from the 4.18.1 bundle): `npmRegistryServer` `https://registry.yarnpkg.com`, `httpTimeout` `1m` (a DURATION), `httpRetry` 3, `networkConcurrency` 50, `enableStrictSsl` true. `httpsCaFilePath`, `httpsKeyFilePath` and `httpsCertFilePath` are absolute paths. `httpProxy` and `httpsProxy` are strings with no env fallback. `unsafeHttpWhitelist` holds hostname globs: an `http:` registry not on it is refused. `networkSettings` holds per-hostname globs.

## Berry's version choice for a range (part C)

Probed on yarn 4.18.1, 2026-11-03, with `yarn install` against a local registry with set times, deprecations and tags. The code was read from the bundle (`getCandidates`, `l2`, `Rvt`, `Qvt`, `Tvt`):
1. The candidates are the versions satisfying the range; prereleases only when the range names one (p-pre).
2. The `npmMinimalAgeGate` filter (a DURATION in minutes, default `1d`, also settable per scope) drops versions younger than the gate. A version with no publish time counts as too young. `npmPreapprovedPackages` (descriptors or name globs, with an optional range) are exempt. When every satisfying version is dropped, berry fails: `All versions satisfying "^1.0.0" are quarantined`.
3. Non-deprecated versions are preferred; all of them are used if all are deprecated (p-deprecated: 1.0.1 over a deprecated 1.0.2).
4. The highest wins. There is no `latest`-tag preference (p-latest: 1.0.2 over the tagged 1.0.1).

**Decision:**
- Part C uses `wantedVersion(range, pkg, { preferLatest: false })` for berry, which covers steps 1, 3 and 4. `main`'s berry discovery used `semver.maxSatisfying` over `yarn npm info`, so it had no gate and no deprecated skip either.
- The age gate (step 2), for `wanted` and for a past-the-range target, goes to a follow-up issue. It needs publish times for every candidate: deps.dev has them, and a private registry needs the full packument (the session's `releaseTimes`).

## Part C plan

- `yarn.lock` (berry) reader. For each row, the workspace entry `<name>@workspace:<path>` gives `dependencies[key]`, the descriptor `key@<value>`. The entry whose key list holds that descriptor gives `version`. A `workspace:` value is a member, so it is linked. It reads aliases (`m@npm:ms@^2`) and builtin patches as they are written.
- Berry gets `installedFromLockfile` → always `yarn.lock`, PnP or node-modules linker. `ownDiscovery`, `discoverBerry`, `parseBerryInfo`, `parseBerryRegistry`, `yarn npm info` and `yarn info` go. `installed()` reads `yarn.lock` after apply.
- `discoverFromRegistry` takes the berry `wanted` option (`preferLatest: false`).
- Done when: berry `check` runs no `yarn` command; bench cold under 1 s; the integration matrix passes unchanged.
