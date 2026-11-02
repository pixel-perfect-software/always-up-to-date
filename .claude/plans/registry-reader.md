# Registry reader: `latest`, versions, deprecation and publish times

Issue: #105. Branch: `feat/105-registry-reader` (from `main` after #111 and #112). Milestone: M3. Planned 2026-10-26.

- [x] Phase 1: One registry config and client per run; per-request `Accept` and timeout
- [x] Phase 2: The reader, its sources and fallbacks, fixtures, config switch, docs, real run

Each phase leaves `pnpm run check-types`, `pnpm run format-and-lint`, `pnpm test` and `pnpm run build` green. Don't commit; the orchestrator commits per phase.

**Decided 2026-10-26: document it** (the user chose the plan's answer; `depsDev: false` is the switch, no credential-based skip). The question was: private packages published to registry.npmjs.org (a paid npm org's private scope) resolve to the public registry, so their names go to deps.dev, which 404s them. The plan documents this in the schema and README, with `depsDev: false` as the switch. The alternative is to skip deps.dev whenever `.npmrc` holds credentials for registry.npmjs.org, which would turn it off for most developers who have run `npm login`.

## Overview

**Goal.** autd gets its own per-package registry reader on #46's `node:https` client. #106 (native discovery) and #47 (cooldown) consume it later. Along the way, the deferred #112 review item is fixed: one `RegistryConfig` and one client per command run.

**Acceptance criteria**

1. **One session per run.** `openProject` gives `Project` a lazy registry session.
   - The `.npmrc` layers and the `cafile` are read at most once per run.
   - Every registry request in the run (cooldown and reader) goes through one client.
   - Opening a project reads no `.npmrc` and loads no client.
2. **Per-request options.** `getJson` takes a per-request `accept` (the default stays `application/json`) and a per-request `timeout`. Cooldown's full-packument request is unchanged.
3. **Lookup result.** `session.lookup(name)` returns:
   - `{ ok: true, package: { name, latest, versions, source } }`, where `versions` holds every valid version with its deprecation and, when the source has it, its publish time;
   - or `{ ok: false, name, kind, reason }`.
   - A network failure is never reported as an empty version list.
4. **Public npm names.** These are names whose resolved registry is `https://registry.npmjs.org/` or `https://registry.yarnpkg.com/`.
   - `latest` comes from `/-/package/<name>/dist-tags`.
   - Versions, deprecation and publish times come from deps.dev.
   - Fall back to the abbreviated packument when deps.dev's list lacks `latest`, when it answers 404, 429 or 5xx, or when it can't be reached.
5. **Other registries.** One `GET /<name>` with the abbreviated `Accept`. On a 404, retry once for the full document, as pacote does.
6. **Packument wins.** When the packument's versions lack the dist-tags' `latest`, its own `latest` is used.
7. **deps.dev is never asked about another registry's names.** Nothing goes to deps.dev for a name on any other registry, or when `depsDev: false`. No credentials are ever sent to deps.dev.
8. **One run-wide limiter** bounds the reader's in-flight requests.
9. **Startup stays lean.** `__tests__/startup.test.ts` proves neither the client nor the reader loads with the CLI.
10. **Tests and a real run.**
    - Unit tests serve bodies captured with curl, from local servers.
    - A real run from built `dist` over the 40 benchmark packages reports time, bytes and how many packages took each path.
11. **Cooldown is unchanged.** `releaseTimes` still reads the full packument and fails open.

**Out of scope**
- Discovery and the `wanted` computation (#106).
- Cooldown on the reader (#47).
- The disk cache and ETag revalidation (#108).
- No command uses `lookup` yet, so `depsDev` has no effect on a run until #106. Say so in the PR's Not verified.

## Technical Architecture

### Modules

| File                             | Change   | Holds                                                                                                                                                  | Loads                                                                                                                        |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/registryClient.ts`    | changed  | `accept` and `timeout` per request; `stats()`                                                                                                          | lazily (unchanged)                                                                                                           |
| `src/utils/registryRequest.ts`   | changed  | Pure helpers: `ABBREVIATED_ACCEPT`, `RegistryEndpoints`, `DEFAULT_ENDPOINTS`, `isPublicNpmRegistry`, `distTagsUrl`, `depsDevUrl`, `isValidPackageName` | at startup, as today                                                                                                         |
| `src/utils/registry.ts`          | reshaped | `createRegistrySession(cwd, options)`, `RegistrySession`. `fetchReleaseTimes` and `clearRegistryCache` are removed                                     | at startup; top-level imports limited to types, `registryRequest`, `npmrcLoader` (already loaded by the barrel) and `logger` |
| `src/utils/registryReader.ts`    | new      | `createRegistryReader(options)`                                                                                                                        | only via `await import()` from the session                                                                                   |
| `src/utils/registryDocuments.ts` | new      | Pure parsers for dist-tags, deps.dev and packuments                                                                                                    | only via the reader                                                                                                          |
| `src/utils/limiter.ts`           | new      | `createLimiter(max)`                                                                                                                                   | only via the reader                                                                                                          |
| `src/types.ts`                   | changed  | `RegistryVersion`, `RegistryPackage`, `PackageLookup`, `AlwaysUpToDateConfig.depsDev`                                                                  | types                                                                                                                        |
| `src/project.ts`                 | changed  | `Project.registry: RegistrySession`                                                                                                                    |                                                                                                                              |
- **Barrel rule.** Don't re-export `registryReader`, `registryDocuments` or `limiter` from `src/utils/index.ts`: it loads at startup. `export type` is fine.
- **No new dependencies.**
  - The reader uses `compare` and `prerelease` from the existing `semver`.
  - The client already uses `stream/promises` `pipeline`, and an async-generator transform stage works on the Node floor.

### Session (Phase 1)

```ts
// src/utils/registry.ts
export interface RegistrySession {
  /** The run's .npmrc view: loaded on the first call, the same object after. */
  registryConfig(): RegistryConfig
  /** The run's one client; node:https, node:http and zlib load on the first call. */
  client(): Promise<RegistryClient>
  /** Cooldown (unchanged behavior): every version's publish time from the full packument; {} on any failure; one request per name per run. */
  releaseTimes(name: string): Promise<Record<string, string>>
  /** Phase 2: latest, versions, deprecation, publish times; one lookup per name per run; never rejects for network, HTTP or parse failures. */
  lookup(name: string): Promise<PackageLookup>
  /** Destroys the client's agents. Safe to call twice, or when no client was made. */
  close(): void
}

export interface RegistrySessionOptions {
  depsDev?: boolean // phase 2; default true (the config default)
  loadConfig?: (cwd: string) => RegistryConfig // test seam; default loadRegistryConfig
  clientOptions?: RegistryClientOptions // test seam: sleep, lookup
  endpoints?: RegistryEndpoints // phase 2 test seam; default DEFAULT_ENDPOINTS
}
```

- **Memoized client.** `client ??= import('./registryClient').then(({ createRegistryClient }) => createRegistryClient(registryConfig(), options.clientOptions))`. Concurrent first callers share one client, which replaces today's raced re-check.
- **Memoized config.** `config ??= load(cwd)`.
- **`releaseTimes`.** Port `requestReleaseTimes` unchanged: the full packument with the default `Accept`, only the string `time` entries, an in-flight map per session, and any failure returns `{}` with a debug line.
- **Closing.** Each command calls `project.registry.close()` in a `finally`.

### Client changes (Phase 1)

```ts
getJson(url: string, registry: string,
        options?: { signal?: AbortSignal; accept?: string; timeout?: number }): Promise<unknown>
stats(): Record<string, { responses: number; bodyBytes: number; decodedBytes: number }>  // keyed by url.host
```

- **`accept`.** `once()` sends `accept ?? 'application/json'`, kept across redirects and retries.
- **`timeout`.** `AbortSignal.timeout(timeout ?? config.fetchTimeout)`; the ETIMEDOUT message names the effective value.
  - The reader passes `Math.min(config.fetchTimeout, DEPS_DEV_TIMEOUT_MS = 5_000)` for deps.dev only.
  - Why: deps.dev is an accelerator with a fallback. A network that blackholes it must not stall a run for minutes.
- **`stats()`.**
  - `responses` counts every response, whatever its status.
  - `bodyBytes` counts the bytes of 2xx bodies as received (gzip bytes when compressed).
  - `decodedBytes` counts them after gunzip.
  - Count with a first pipeline stage, not a `'data'` listener, which conflicts with async iteration:

  ```ts
  async function* count(source: AsyncIterable<Buffer>) { for await (const c of source) { received += c.length; yield c } }
  await pipeline(res, count, ...(gzip ? [zlib.createGunzip()] : []), sink)
  ```

### Reader types (Phase 2, `src/types.ts`)

```ts
export interface RegistryVersion {
  version: string
  deprecated: boolean
  /** The deprecation message, when the source gives a non-empty one. */
  deprecatedReason?: string
  /** ISO 8601, when the source has it (deps.dev always; packuments only with `time`). */
  publishedAt?: string
}
export interface RegistryPackage {
  name: string
  /** Always one of `versions`. */
  latest: string
  /** Every version whose string is canonical semver, ascending (semver.compare). */
  versions: RegistryVersion[]
  source: 'deps.dev' | 'packument'
}
export type LookupFailureKind = 'not-found' | 'request' | 'invalid'
export type PackageLookup =
  | { ok: true; package: RegistryPackage }
  | { ok: false; name: string; kind: LookupFailureKind; reason: string }
```

- It serves #106's `wanted` rule (an exact pin is its own; else `latest` when in range and not deprecated; else the highest satisfying non-deprecated version; else the highest satisfying).
- It serves #47 through per-version `publishedAt`, absent when unknown.
- It is plain JSON, so #108 can cache it.
- `deprecated` is an explicit boolean. A string field would make `if (v.deprecated)` miss deps.dev deprecations whose `deprecatedReason` is empty.

### Endpoints and helpers (Phase 2, `registryRequest.ts`, pure)

```ts
export const ABBREVIATED_ACCEPT =
  'application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'
export interface RegistryEndpoints {
  publicRegistries: readonly string[]
  depsDev: string
}
export const DEFAULT_ENDPOINTS: RegistryEndpoints = {
  publicRegistries: [
    'https://registry.npmjs.org',
    'https://registry.yarnpkg.com',
  ], // origins
  depsDev: 'https://api.deps.dev/v3/systems/npm/packages/',
}
```

- **`isPublicNpmRegistry(registry, origins)`.** True when `new URL(registry)` has an `origin` in `origins` and its `pathname` is `/`. Anything else, including any scope registry, takes the single-GET path.
- **`distTagsUrl(name, registry)`.** `<base>/-/package/<name with '/'→'%2f'>/dist-tags`, with the base trimmed and normalized as `packumentUrl` does.
- **`depsDevUrl(name, base)`.** `base + encodeURIComponent(name)`, which gives `%40types%2Fms`.
- **`isValidPackageName(name)`.** A URL-safety rule, so no request is ever built from a name that could traverse paths.
  - The name is unscoped, or `@scope/pkg` split at the first `/`.
  - Each part is non-empty, not `.` or `..`, and `encodeURIComponent(part) === part`.
  - At most 214 characters.

### Lookup algorithm (Phase 2, `registryReader.ts`)

```ts
createRegistryReader({ registryConfig, client, depsDev, endpoints = DEFAULT_ENDPOINTS }): { lookup(name): Promise<PackageLookup> }
```

- **Run state.**
  - `cache: Map<name, Promise<PackageLookup>>` dedupes in-flight lookups.
  - `limit = createLimiter(registryConfig.maxSockets)`.
  - `let depsDevUsable = depsDev`.
- **Every HTTP call** is `limit(() => client.getJson(url, base, { accept, timeout }))`.
  - For npm requests, `base` is the name's registry.
  - For deps.dev, `base` is `endpoints.depsDev`. Never pass the npm registry there: this keeps `credentialsFor`'s same-host fallback scoped to deps.dev's own host.

```
lookup(name):
  invalid name                         → fail('invalid', `${JSON.stringify(name)} is not a valid package name`)  (no request)
  registry = registryFor(name, registryConfig)
  depsDevUsable && isPublicNpmRegistry(registry) → publicLookup
  else                                 → packumentLookup(name, registry)

publicLookup(name, registry):
  [tags, dd] = await Promise.all([ get(distTagsUrl, registry, 'application/json'), depsDevVersions(name) ])
  tags failed with 404                 → fail('not-found', `${name} is not in ${origin}`)
  tags failed otherwise / no valid latest → packumentLookup(name, registry)            (debug line)
  dd ok && dd.some(v => v.version === tags.latest) → ok({ latest: tags.latest, versions: dd, source: 'deps.dev' })
  else                                 → packumentLookup(name, registry, tags.latest)   (debug line: why)

depsDevVersions(name):            // never rejects
  !depsDevUsable                       → unavailable
  404                                  → unavailable('not on deps.dev')
  429, ≥500, or no status (transport/timeout) → depsDevUsable = false (one debug line: "deps.dev unavailable (…); reading packuments for the rest of the run") → unavailable
  other status / unparseable body      → unavailable (per package)

packumentLookup(name, registry, expectedLatest?):
  get(packumentUrl, registry, ABBREVIATED_ACCEPT); on 404 retry once with 'application/json' (pacote)
  404 again → fail('not-found'); other request failure → fail('request', error.message)
  parsePackument → undefined → fail('invalid', `${host} sent an unreadable document for ${name}`)
  no versions → fail('not-found', `${name} has no published versions`)
  latest = expectedLatest if listed
         ?? packument dist-tags.latest if listed            ("packument wins")
         ?? highest version with semver.prerelease(v) === null
         ?? highest version
  ok({ latest, versions, source: 'packument' })
```

- **No secrets in reasons.** `RegistryRequestError` messages are already redacted. Name registries by `new URL(registry).origin` or `.host`, never the raw URL, which may carry userinfo.
- **`depsDev: false`** sends public names down the single-GET path too.
- **`lookup` always resolves** for network, HTTP and parse failures. Only programmer errors reject.

### Parsers (Phase 2, `registryDocuments.ts`, pure, tested on fixtures)

- **`parseDistTags(body): string | undefined`.** Returns `latest` when the body is an object and `semver.valid(latest) === latest`.
- **`parseDepsDevPackage(body): RegistryVersion[] | undefined`.**
  - `undefined` unless `body.versions` is an array.
  - Each entry keeps `versionKey.version` only when it is canonical semver.
  - `deprecated: isDeprecated === true`; `deprecatedReason` only when non-empty; `publishedAt` only when it is a string that `Date.parse` accepts.
  - Sorted ascending.
- **`parsePackument(body): { latest?: string; versions: RegistryVersion[] } | undefined`.** Works on abbreviated or full documents.
  - `versions` must be an object, and only canonical semver keys are kept. Iterate `Object.entries`; `__proto__` and other junk fail `semver.valid`.
  - `deprecated`: a non-empty string or `true` (npm treats `""` as un-deprecated).
  - `publishedAt` from `time[v]`, when `Object.hasOwn(time, v)` and it parses.
  - `latest` from `dist-tags.latest`, when valid.

### Limiter (Phase 2, `limiter.ts`)

```ts
export const createLimiter = (max: number) => {
  let active = 0
  const waiting: Array<() => void> = []
  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active < max) active++
    else await new Promise<void>((resolve) => waiting.push(resolve)) // slot handed over; active unchanged
    try {
      return await task()
    } finally {
      const next = waiting.shift()
      if (next) next()
      else active--
    }
  }
}
```

The default limit is `registryConfig.maxSockets` (npm's default is 15). The reasons:
1. A queued request can't burn its timeout. The client starts `AbortSignal.timeout` before the agent assigns a socket, and capping in-flight requests at `maxsockets` means no agent queue forms.
2. It is run-wide across hosts, so deps.dev never sees more than that many concurrent requests.
3. It bounds how many whole packument bodies are buffered at once (next is 25.7 MB decoded) when deps.dev is off or falls back.
4. It adds no setting: lowering `maxsockets` lowers it.

The 40-package benchmark makes about 80 small requests, about 6 waves. If the real run misses the 1 s cold budget, the one-line fallback is `2 × maxSockets`.

### Config switch (Phase 2)

- `depsDev: boolean`, default `true`, in `AlwaysUpToDateConfig` and `DEFAULT_CONFIG`.
- Validated strictly. `Boolean("false")` is `true`, and a privacy switch must not fail open:

  ```ts
  const parseDepsDev = (input: unknown): boolean => {
    if (input === undefined) return DEFAULT_CONFIG.depsDev
    if (typeof input === 'boolean') return input
    throw new Error(`depsDev must be true or false (got ${JSON.stringify(input)})`)
  }
  ```

- `INITIAL_CONFIG` and `autd init` don't change.
- `openProject` passes `{ depsDev: config.depsDev }` to `createRegistrySession`.

## Phase 1: One registry config and client per run; per-request `Accept` and timeout

**Code**
1. `src/utils/registryClient.ts`: `getJson` options gain `accept` and `timeout`; add `stats()` per host; update the `RegistryClient` interface and its doc.
2. `src/utils/registry.ts`: replace the module-level `releaseTimeCache`, `clients`, `clientFor`, `fetchReleaseTimes` and `clearRegistryCache` with `createRegistrySession`. Omit `lookup` until Phase 2.
3. `src/project.ts`: `Project` gains `registry: RegistrySession`; `openProject` sets `registry: createRegistrySession(cwd)`.
4. `src/utils/releaseAges.ts`: the signature becomes `computeReleaseAges(outdated, registry: Pick<RegistrySession, 'releaseTimes'>, cooldown, now)`; drop `loadRegistryConfig`.
5. `src/utils/filterPackages.ts`: `FilterPackagesOptions` gains a required `registry: Pick<RegistrySession, 'releaseTimes'>`. Drop the `loadRegistryConfig` and `fetchReleaseTimes` imports; the cooldown gate calls `registry.releaseTimes(result.name)`.
6. `src/pipeline.ts`: `discover` passes `project.registry` to `computeReleaseAges`, and `plan` passes `registry` to `filterPackages`.
7. `src/utils/index.ts`: replace the `clearRegistryCache` and `fetchReleaseTimes` exports with `createRegistrySession` and `type RegistrySession`.
8. `src/commands/check.ts` and `src/commands/update.ts`: `let project: Project | undefined` before the `try`, and `finally { project?.registry.close() }`.
9. Sweep for remaining callers: `rg -n "fetchReleaseTimes|clearRegistryCache|loadRegistryConfig|computeReleaseAges|utils/registry'" src __tests__ bench`.

**Tests**
- `__tests__/utils/registryClient.test.ts`:
  - it sends the `accept` it's given, and the default stays `application/json` (extend the transport test);
  - `accept` is kept across a redirect;
  - a per-request `timeout` overrides `fetch-timeout` (a `never` handler with `timeout: 100`);
  - `stats()` on a gzip body: `bodyBytes` is the gzip length and `decodedBytes` the raw length;
  - a 404 counts in `responses` only.
- `__tests__/utils/registry.test.ts`: rewrite against `createRegistrySession(cwd, { loadConfig: () => configFor(...) })`.
  - Keep every current case: dedupe; one client for concurrent first calls; fails open once; unreachable; string-only `time`; a scoped registry with its own credentials (#104).
  - "A new session asks again" replaces "after the cache is cleared".
  - Add: creating a session calls `loadConfig` 0 times, and exactly once after `releaseTimes` on two names plus `client()`.
  - Add: sequential `releaseTimes` calls to one server share a connection (`server.connections === 1`).
  - Add: `close()` before any request is a no-op.
- `__tests__/utils/releaseAges.test.ts`: drop `isolateModules` and the `doMock`s; pass `{ releaseTimes: async (n) => … }`.
- `__tests__/utils/filterPackages.test.ts`: in `loadFilterWithConfig`, drop the `npmrcLoader` and `registry` `doMock`s. `run` passes `registry: { releaseTimes: jest.fn(async (n) => opts.releaseTimes?.[n] ?? {}) }`; adapt any assertion on `fetchReleaseTimes` to that `jest.fn`.
- `__tests__/fixtures/index.ts`: add `fakeRegistry(overrides?: Partial<RegistrySession>): RegistrySession`. Every method throws `unexpected registry access in a unit test` unless overridden, and `close` is a no-op. Change `projectFor(adapter, cwd, config?, registry = fakeRegistry())`.
- `__tests__/project.test.ts`: mock `@/utils/registry` as `{ createRegistrySession: jest.fn(() => session) }`, and expect `{ cwd, config, adapter, registry: session }` created with `'/project'`. Laziness itself is tested in `registry.test.ts`.
- Every `jest.mock('@/utils/registry', () => ({ clearRegistryCache, fetchReleaseTimes }))` breaks.
  - Known places: `pipeline.test.ts`, `singlePackageJson.test.ts`, `managers/withinRange.test.ts`, `commands/failures.test.ts`, `commands/jsonOutput.test.ts`, and the project test. Find the rest with rg.
  - Delete the mock where nothing uses cooldown: a session does no I/O until asked, and `projectFor` now carries a throwing fake.
- `commands/failures.test.ts`: add "closes the run's registry session after a failed and after a successful command", with `createRegistrySession` mocked to return a fake whose `close` is a `jest.fn`.

**Docs**
- `CLAUDE.md`:
  - The `src/project.ts` bullet: `Project` is `{ cwd, config, adapter, registry }`, and `registry` is lazy.
  - Replace the stale bullet "`src/utils/registry.ts` fetches version timestamps via `npm-registry-fetch`" (stale since #112). The new one: `createRegistrySession(cwd)` holds the run's `.npmrc` view and its one `node:https` client, both loaded on first use, plus `releaseTimes(name)` for cooldown, cached per run and failing open.
- `src/utils/CLAUDE.md`: the registry section and file list. `registry.ts`'s allowed top-level imports now include `npmrcLoader`.
- `src/commands/CLAUDE.md`, "Command Flow": a step 3 that closes the session in `finally`.
- `.claude/context/ai-context/docs-overview.md`: the `project.ts` line and the `registry.test.ts` description.

**Gates:** `pnpm run check-types`, `pnpm run format-and-lint`, `pnpm test`, `pnpm run build`. Optional, since the command path changed: `AUTD_INTEGRATION_PM=npm pnpm run test:integration`. Suggested commit: "Load the registry config and client once per run" (Refs #105).

## Phase 2: The reader, its sources and fallbacks, fixtures, config switch, docs, real run

**Code**
1. `src/types.ts`: the reader types and `depsDev`.
2. `src/utils/registryRequest.ts`: the helpers and constants above.
3. New modules as specified: `src/utils/registryDocuments.ts`, `src/utils/limiter.ts`, `src/utils/registryReader.ts`.
4. `src/utils/registry.ts`: the session gains `lookup(name)`, backed by a lazily built reader:

   ```ts
   reader ??= Promise.all([import('./registryReader'), clientOnce()]).then(([{ createRegistryReader }, client]) =>
     createRegistryReader({ registryConfig: registryConfig(), client, depsDev: options.depsDev ?? true, endpoints: options.endpoints }))
   ```

   `lookup` then calls `(await reader).lookup(name)`.
5. `src/utils/config.ts`: `DEFAULT_CONFIG.depsDev = true`, and `parseDepsDev`.
6. `src/project.ts`: `createRegistrySession(cwd, { depsDev: config.depsDev })`.
7. `schema/config.schema.json`: `depsDev` (`type: boolean`, `default: true`), with this description:

   > Look up versions of packages served by the public npm registry (registry.npmjs.org, registry.yarnpkg.com) through deps.dev, Google's open-source dependency service: about 10 KB per package instead of a registry document that can run to megabytes. Each such package name is sent to api.deps.dev, including private packages published to registry.npmjs.org. Names from any other registry, including a scope's own registry, are never sent. false reads everything from the registry.

8. `README.md` config table: a `depsDev` | `true` row with the same content, shortened.
9. `CLAUDE.md`, Configuration System "Supports:":
   - **`depsDev`:** `true` (default) or `false`, validated strictly. Only names on registry.npmjs.org or registry.yarnpkg.com are ever sent.
   - **A reader bullet:** `session.lookup(name)` loads `src/utils/registryReader.ts` lazily and returns `PackageLookup`. That is ok, or a failure with a reason, and never "no versions" for a network failure.
     - Public npm uses dist-tags plus deps.dev, falling back to the abbreviated packument.
     - Other registries use one GET with the abbreviated Accept.
     - The packument wins, and a run-wide limiter of `maxsockets` applies.
10. `src/utils/CLAUDE.md`: document the reader, the documents module and the limiter. Rewrite the guideline "Network/IO utilities … must fail open": cooldown's `releaseTimes` fails open, while the reader reports failures per package and the consumer decides. Without that, the next agent will "fix" the reader to fail open.

**Fixtures** in `__tests__/fixtures/registry/`
- Bodies are verbatim decoded responses with a `.body` extension, following the `.stdout` precedent. Biome skips the extension, so the bytes stay exact.
- The directory sits beside `__tests__/fixtures/registry.ts`; the file resolves first, and the directory has no index.
- Headers stay out of the repo. Save them to the scratchpad. Record each file's status, content type, wire size and capture date, with the Aikido note, in `__tests__/fixtures/registry/README.md`.

```sh
D=__tests__/fixtures/registry; H=<scratchpad>/registry-headers; mkdir -p "$D" "$H"
ABBREV='application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'
cap() { curl -sS --compressed -H "Accept: $3" -D "$H/$1.headers" -o "$D/$1.body" \
          -w "$1 %{http_code} %{size_download}B %{content_type}\n" "$2"; }
cap ms.dist-tags             https://registry.npmjs.org/-/package/ms/dist-tags            application/json
cap types-ms.dist-tags       https://registry.npmjs.org/-/package/@types%2fms/dist-tags   application/json
cap mkdirp.dist-tags         https://registry.npmjs.org/-/package/mkdirp/dist-tags        application/json
cap ms.deps-dev              https://api.deps.dev/v3/systems/npm/packages/ms              application/json
cap types-ms.deps-dev        https://api.deps.dev/v3/systems/npm/packages/%40types%2Fms   application/json
cap mkdirp.deps-dev          https://api.deps.dev/v3/systems/npm/packages/mkdirp          application/json
cap ms.packument             https://registry.npmjs.org/ms                                "$ABBREV"
cap types-ms.packument       https://registry.npmjs.org/@types%2fms                       "$ABBREV"
cap mkdirp.packument         https://registry.npmjs.org/mkdirp                            "$ABBREV"
cap types-ms.packument-full  https://registry.npmjs.org/@types%2fms                       application/json
cap not-found.deps-dev       https://api.deps.dev/v3/systems/npm/packages/autd-no-such-package-20261026 application/json
```

Checks before committing:
- **The made-up name is unknown everywhere.** It also 404s on npm, and the deps.dev capture is `404 text/plain`.
- **No package has a release in the last weeks.** Check `jq -r .modified` and the newest `time` entry. If `@types/ms` is fresh, substitute another small, stable scoped package.
- **mkdirp has mixed deprecation:** at least one deprecated version, and a `latest` that isn't deprecated. If not, pick another small package.
- **The sources agree.** Per package, deps.dev's version count equals the packument's, both include the dist-tags `latest`, and the deprecated sets match. This guards against the Aikido rewrite.
- **yarnpkg serves the dist-tags endpoint.** `curl -sS --compressed https://registry.yarnpkg.com/-/package/ms/dist-tags` (not committed) must equal the npmjs body. **If yarnpkg 404s or differs, stop and report.**
- **No credentials.** curl reads no `.npmrc`, and no auth flags are passed.

Test helper, in `__tests__/fixtures/registry.ts`:

```ts
export interface Reply { status?: number; type?: string; body: string }
/** Answers from an exact req.url → reply table; anything else is 404 text/plain. */
export const replies = (table: Record<string, Reply>): Handler   // export Handler too
```

Variants are derived from a captured body with `derive(file, edit)` (parse, edit, stringify), never hand-written. Examples: drop `latest` from deps.dev's list; remove a version from the packument.

**Tests**
- **`__tests__/utils/registryDocuments.test.ts`**, on the fixtures:
  - Parsing:
    - dist-tags `latest`;
    - deps.dev versions, deprecated flags and reasons, and `publishedAt`;
    - an abbreviated packument has no `publishedAt`;
    - a full packument has `publishedAt` for every version.
  - Per package, deps.dev and the packument agree on the version sets and the deprecated sets.
  - Malformed input gives `undefined`: a non-object; `versions` of the wrong type; non-semver and `__proto__` keys.
- **`__tests__/utils/registryReader.test.ts`.**
  - **Setup.** A local "registry" server and a separate local "deps.dev" server.
    - Pass `endpoints = { publicRegistries: [registry origin], depsDev: depsDevUrl + 'v3/systems/npm/packages/' }`.
    - Use the client from `createRegistryClient(config, { sleep: async () => {} })` with `fetchRetries: 0`, unless a case tests retries.
  - **The deps.dev path.**
    - A public name that deps.dev lists with `latest` comes from source `deps.dev`, in exactly 2 requests, both `accept: application/json`, with no packument request.
    - A scoped name requests `/-/package/@types%2fms/dist-tags` and `/v3/systems/npm/packages/%40types%2Fms`.
  - **Fallbacks to the packument,** each with `accept === ABBREVIATED_ACCEPT`:
    - deps.dev's list lacks `latest` (derived variant);
    - deps.dev answers 404 (the captured `text/plain` body);
    - deps.dev answers 429;
    - the deps.dev server is closed.
  - **The breaker.**
    - After a 429, a transport failure or a 5xx, the next lookup sends nothing to deps.dev.
    - After a 404, the next lookup still asks deps.dev.
  - **`depsDev: false`.** Zero requests reach the deps.dev server. A public name makes one packument request and no dist-tags request.
  - **A non-public registry.**
    - It gets one `GET /<name>` with the abbreviated Accept, and nothing goes to deps.dev, even with `depsDev: true`.
    - When it serves the full document there, the versions get `publishedAt`.
  - **A scope registry** gets the request with its own token; the deps.dev server gets nothing.
  - **No credentials to deps.dev.** With `//127.0.0.1:<registryPort>/:_authToken=TOK`, registry requests carry `Bearer TOK` and deps.dev requests carry no `authorization`.
  - **Packument wins.**
    - When the packument lacks the dist-tags' `latest`, its own `latest` is used.
    - When that is missing too, the highest stable version is used.
  - **404s.**
    - An abbreviated 404 is retried with `application/json` and succeeds.
    - A second 404 gives `{ ok: false, kind: 'not-found' }`.
    - A dist-tags 404 gives `not-found`, with no packument request.
  - **Failures.**
    - An unreachable registry gives `{ ok: false, kind: 'request', reason }`, never `ok` with empty versions.
    - An unparseable document gives `invalid`.
    - An invalid name gives `invalid`, with zero requests.
    - Registry URL userinfo never appears in a reason.
  - **Dedupe.** 3 concurrent lookups of one name make one set of requests.
  - **Bounded concurrency.** With `maxSockets: 2`, 8 names peak at 2 or fewer in flight across both hosts. Use one combined server serving both route tables, so `peak` covers everything.
  - **deps.dev timeout.** It is 5 s, capped by `fetchTimeout`. With a `never` deps.dev handler and `fetchTimeout: 100`, the lookup falls back and resolves.
- **`__tests__/utils/limiter.test.ts`:**
  - the peak never exceeds `max`;
  - tasks run FIFO;
  - a rejection frees its slot;
  - results and errors propagate.
- **`__tests__/utils/registryRequest.test.ts`:**
  - `isPublicNpmRegistry` accepts npmjs and yarnpkg with or without a trailing slash, and rejects `http:`, another path or another host.
  - `distTagsUrl` and `depsDevUrl` escaping.
  - `isValidPackageName` rejects `..`, `@scope/..`, `a/b/c`, `%2e`, empty parts and over 214 characters, and accepts legacy uppercase.
- **`__tests__/utils/registry.test.ts`:**
  - `lookup` dedupes per session.
  - `lookup` and `releaseTimes` share one client (one connection for sequential requests) and one config load.
  - `depsDev: false` reaches the reader.
- **`__tests__/utils/config.test.ts`:**
  - Defaults to `true`, and reads `false`.
  - Rejects `"false"` and `0` with the message above.
  - Update any `toEqual(DEFAULT_CONFIG)` expectations.
- **`__tests__/project.test.ts`:** `{ depsDev }` from the config reaches `createRegistrySession`.
- **`__tests__/startup.test.ts`:** add `jest.mock('@/utils/registryReader', () => { mockReaderLoaded(); return {} })` and assert it isn't called.

**Docs:** `.claude/context/ai-context/docs-overview.md` gets the new source files, test files and the fixture directory.

**Gates:** `pnpm run check-types`, `pnpm run format-and-lint`, `pnpm test`, `pnpm run build`, then the real run. Suggested commits: the fixtures with their README; then "Read latest, versions, deprecation and publish times from the registry" (Closes #105).

**Real run (gate).** A scratchpad script, `<scratchpad>/reader-run.cjs`, not committed. Run it after `pnpm run build`:

```js
const path = require('node:path')
const ROOT = '/Users/tylerrobertson/personal_dev/always-up-to-date'
const { createRegistrySession } = require(
  path.join(ROOT, 'dist/utils/registry.js'),
)
const bench = path.join(ROOT, 'bench/pinned')
const names = Object.keys(
  require(path.join(bench, 'package.json')).dependencies,
)
const depsDev = !process.argv.includes('--no-deps-dev')
;(async () => {
  const session = createRegistrySession(bench, { depsDev })
  const t0 = performance.now()
  const results = await Promise.all(names.map((n) => session.lookup(n)))
  const seconds = (performance.now() - t0) / 1000
  const stats = (await session.client()).stats()
  session.close()
  const paths = {}
  for (const r of results) {
    const k = r.ok ? r.package.source : `failed:${r.kind}`
    paths[k] = (paths[k] ?? 0) + 1
  }
  console.log(
    JSON.stringify(
      {
        depsDev,
        seconds,
        paths,
        stats,
        failures: results.filter((r) => !r.ok),
      },
      null,
      2,
    ),
  )
})().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
```

- Run it 3 times with the default, and once with `--no-deps-dev`.
- Report:
  - the median seconds;
  - per host, the responses, wire bytes and decoded bytes (`api.deps.dev` must show 0 with `--no-deps-dev`);
  - packages per path;
  - any failures, naming each package that fell back because deps.dev lacks a fresh `latest`.
- Note the date and the Aikido proxy.
- Compare with the brief: dist-tags 5.1 KB for the 40; deps.dev about 10 KB per package; abbreviated packuments 53 MB and about 16 s.

## Design considerations

- **Performance.**
  - The default path makes two small requests per public package.
  - Packuments are fetched only on fallback, and the limiter bounds the buffering.
  - Within a run, nothing is fetched twice.
- **Startup.** The reader, documents and limiter load on the first `lookup()`, and the client on first use. `registry.ts` keeps its top-level imports cheap, and the startup test guards both.
- **Privacy.**
  - Only the package name in the URL path goes to deps.dev, with no credentials. `.npmrc` scoping stays per host.
  - The proxy, CA and `strict-ssl` settings apply to deps.dev, since it uses the same client.

## Risks & mitigation

1. **Private packages on registry.npmjs.org are sent to deps.dev.** This is documented, with `depsDev: false` as the switch. See the open decision at the top.
2. **deps.dev can lag for versions other than `latest`.** A backport published hours ago can be missing for a few hours. Checking every dist-tag was rejected: next's `canary` moves several times a day, which would force its 25.7 MB packument almost every run.
3. **The deps.dev path can propose a version a packument-rewriting proxy hides.** After #106, apply's installed check reports it as "not applied by <pm>".
4. **A network that blackholes api.deps.dev.** The 5 s timeout and the run-wide breaker contain it.
5. **registry.yarnpkg.com may not serve dist-tags.** Verified at capture; stop and report if not.
6. **The deps.dev response shape can change.** The parser returns `undefined` and the reader falls back, which is safe.
7. **Test churn from removing `fetchReleaseTimes` and `clearRegistryCache`.** Contained by the rg sweep, by `fakeRegistry()` as the default (it fails loudly), and by lazy sessions.
8. **The limiter against the 1 s cold budget.** The real run measures it; the fallback is `2 × maxSockets`.

## Decisions made in planning (confirm or veto)

- **A per-run `RegistrySession` on `Project`** replaces the module-level caches; commands close it in `finally`.
- **Client additions:** a per-request `timeout` (deps.dev gets `min(fetchTimeout, 5 s)`) and a per-host `stats()`.
- **Fallback and breaker:** any deps.dev failure falls back for that package. A 429, a 5xx or a transport failure also turns deps.dev off for the rest of the run.
- **dist-tags errors:** a dist-tags 404 means `not-found`; any other dist-tags failure takes the packument path.
- **404 retry:** the pacote-style full-document retry applies to every packument request.
- **`depsDev: false`:** public names take the single-GET path too.
- **The limiter's limit** equals `maxsockets`. Superseded 2026-10-26 in #106's branch: one limiter per host, each of `maxsockets` (lookups 0.75 s → 0.57–0.70 s on the benchmark), and the breaker trips on a 429 or a timeout at once, or after three other 5xx/transport failures.
- **`depsDev` validation:** strict, and not added to `autd init`.
- **Fixtures** are `.body` files plus a README, and the headers aren't committed.
- **The real-run script** stays in the scratchpad, uncommitted.
