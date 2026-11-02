# Registry cache under `ca.pixel-perfect.alwaysuptodate` (#108)

Issue: #108. Milestone: M3. Branch: `feat/108-registry-cache`, cut from `main`; merge `main` in (with #128, #118, #122 as they land) before handover. Planned 2026-10-27.

- [x] Phase 1: The client returns ETags, `Cache-Control`, 304s and whether a request was authenticated. Header captures. No behavior change.
- [x] Phase 2: The store, `src/utils/registryCache.ts`: folder, entries, atomic writes, freshness policy, LRU pruning.
- [x] Phase 3: The reader answers from the store, the client loads lazily, plus `--no-cache`, `AUTD_NO_CACHE`, `AUTD_CACHE_DIR`, the bench, the harness and docs.
- [x] Phase 4: Real-run gates (#106's D6 bar, the Done-when), then the PR.

**Decided 2026-10-27** (the orchestrator, under the user's "go with what's right"; each is the planner's recommendation, recorded here and in the PR so the user can veto):
- **Q1 (a), narrowed in review.**
  - An answer to an authenticated request (any hop carried `Authorization` or a client certificate) is served without asking only when `sameForEveryone`: for dist-tags, deps.dev lists the package (deps.dev indexes only public npm packages). `Cache-Control: public` alone does not count: a private registry can send it too, and would then serve one credential's version list to another.
  - An explicit `private` always means revalidate-only, even with `sameForEveryone`.
  - Any other authenticated answer is stored only with an ETag and revalidated on every use, so the registry authorizes each reader. Without an ETag it isn't stored.
  - Unauthenticated answers keep the rules of decision 3.
  - Keys never include, and files never hold, a token or anything derived from one: an entry holds `sha256(endpoint + name)` (its file's own key), never the endpoint, since a registry path can carry a token (Gemfury).
- **Q2, the bypass:** `--no-cache` on `check` and `update`, and `AUTD_NO_CACHE`, read nothing and write nothing, and don't even resolve the folder. `AUTD_CACHE_DIR=<path>` relocates it, resolved against cwd. `AUTD_NO_CACHE` set to anything but empty, `0` or `false` (trimmed, case-insensitive) disables the cache.
- **Q3 (a):** `releaseTimes` stays uncached until #47.
- **Q4: one PR, three commits.**

**Measured in Phase 1** (2026-10-27, unauthenticated, through this machine's Aikido proxy; table in `__tests__/fixtures/registry/README.md`):

| Endpoint                   | `Cache-Control`        | ETag                                 | Revalidation                                                                           |
| -------------------------- | ---------------------- | ------------------------------------ | -------------------------------------------------------------------------------------- |
| dist-tags (npmjs, yarnpkg) | **none**               | none                                 | none: TTL-only at the default 300 s                                                    |
| abbreviated packument      | `public, max-age=300`  | weak                                 | a 304 on `If-None-Match`                                                               |
| full packument             | `public, max-age=300`  | weak, different from the abbreviated | not tried                                                                              |
| deps.dev                   | `public, max-age=3600` | **none**                             | none: TTL-only, and the "revalidate if deps.dev sends an ETag" branch is dormant today |

dist-tags isn't `public`, so for an authenticated request its answer is cached only through `sameForEveryone` (deps.dev lists the package), as Q1 (a) already says. The proxy may strip headers, so re-check dist-tags off this machine before the PR, or list it as not verified.

Rules for every phase:
- Each phase leaves `pnpm run check-types`, `pnpm run format-and-lint`, `pnpm test` and `pnpm run build` green.
- Phases 3 and 4 also need `pnpm run test:integration` on all five managers, with Corepack's yarn first on PATH (`corepack enable --install-directory <scratchpad>/shims yarn`).
- Don't commit; the orchestrator commits per phase.

Planning limits:
- No real runs were made while planning.
- #108 was read through a WebFetch summary, so re-read it with `gh issue view 108 --comments` before Phase 4.
- Commander 15's negatable options were checked on Context7 (`/tj/commander.js/v15.0.0`): `--no-cache` alone makes `cache` true by default and false when passed.
- npm's own HTTP cache (make-fetch-happen, read 2026-10-27) keys by URL alone (`auth: false`, `shared: false`), so npm stores authenticated answers whoever asked. Q1 (a) is deliberately stricter.

## Decisions made in planning (confirm or veto)

1. **One file per entry:** `<dir>/v1/<kind>/<sha256-hex>.json.gz`, where the key is `sha256(endpointKey + '\n' + name)`.
   - The kind is a directory, so deps.dev and packument entries never share a file.
   - A hash is used because APFS and NTFS are case-insensitive, and `JSONStream` and `jsonstream` are different packages.
   - The entry repeats `kind`, `endpoint` and `name`, and a read checks them.
2. **Entries hold the parsers' outputs, not `RegistryPackage`:**
   - `dist-tags` → `{ latest }`;
   - `deps.dev` → `parseDepsDevPackage`'s `RegistryVersion[]`;
   - `packument` / `packument-full` → `parsePackument`'s `{ latest?, versions }`.

   The reader's rules (packument wins, highest stable, expected latest) then run unchanged on cached input. Entries are gzipped: 1.47 MB of JSON for the 40 benchmark packages is 117–142 KB gzipped.
3. **Freshness:**

   | Kind                      | Default | Then                                                |
   | ------------------------- | ------- | --------------------------------------------------- |
   | dist-tags                 | 300 s   | refetched (no ETag)                                 |
   | deps.dev                  | 3600 s  | refetched, or revalidated if deps.dev sends an ETag |
   | packument, packument-full | 300 s   | revalidated with `If-None-Match`                    |
   - A smaller `max-age` lowers the TTL.
   - `no-store` → not stored.
   - `no-cache`, `max-age=0` or `private` → revalidate-only (needs an ETag), with the Q1 rule on top.
   - `Age` counts against the freshness: the remaining time is `ttl − Age`, clamped at 0 (then revalidate-only), so the bound stays the TTL from the origin. dist-tags and deps.dev send no `Age`.
   - A 304 restates headers (RFC 9111 §4.3.4): its own `Cache-Control` and `Age` apply when present; a 304 silent about `Cache-Control` keeps the stored one (the entry keeps the `Cache-Control` string and whether the request was authenticated).
   - Time counts from when autd received the answer, and a future `storedAt` is stale.
4. **No stale fallback and no negative caching.** A failed request fails its lookup as today (#106's D3), even when a stale entry exists. 404s and failures are never stored.
5. **A fresh deps.dev entry lacking the dist-tags `latest`** sends the lookup back to deps.dev once before the packument. Otherwise next's 25.7 MB abbreviated packument would download every run for up to an hour.
6. **Cap: 32 MiB, no setting.**
   - Sizes are rounded up to 4 KiB, matching `du -sk`.
   - LRU is by mtime: a hit touches the file (`utimesSync`), and a write sets it.
   - At `close()`, a run that created or grew an entry past a 4 KiB boundary scans `<dir>/v1/<kind>/`. If the total is over the cap, it deletes the oldest files until it's under 80%.
   - `*.tmp` files older than 1 h are removed.
   - Only files named `^[0-9a-f]{64}\.json\.gz$` or `*.tmp` inside `v1/` are ever deleted.
7. **Atomic writes.**
   - Write `<file>.<pid>.<8 random hex>.tmp` (`wx`, `0o600`), then `renameSync` it over the entry.
   - Readers see the old file or the new one, never a partial one. A gzip CRC or structure failure is a miss.
   - A failed rename deletes the temp file and keeps the old entry, with a debug line. This covers the Windows lock case.
   - Directories are created with `0o700`.
   - `CACHEDIR.TAG` (`Signature: 8a477f597d28d172789f06886806bc55`) sits in `<dir>/v1/`, never in the folder the user names (`AUTD_CACHE_DIR=.` must not hide a project from backups).
8. **The cache fails open.** A folder that can't be resolved, read or written never fails a run: one debug line, and writes stop for that run. This differs on purpose from lookups, which report failures.
9. **Synchronous writes,** right after each response is parsed: about 80 gzip+rename pairs on a full miss, a few ms.
10. **Read checks are structural only:** types, `schema === 1` and the key fields. No `semver.valid` pass.
11. **The client loads lazily.** The reader takes `client: () => Promise<RegistryClient>`, so a fully fresh run never loads `node:https`, `tls` or the agents.
12. **The session's default is no cache;** only `openProject` turns it on. `__tests__/setup.ts` sets `process.env.AUTD_NO_CACHE = '1'`.
13. **One debug line at `close()`:** the folder, fresh / revalidated (304) / fetched / written, files pruned, and per-host requests (`none` when no client was made).
14. **No new config field and no TTL setting.** If one is ever added, it takes `parseDuration`'s forms.
15. **Yarn berry is untouched** (`ownDiscovery` until #107).

## Overview

**Goal.** A second `check` within 5 minutes on the benchmark makes no network request. Later runs pay only what has expired. Warm `check` time and memory come back to the pre-#106 numbers (#106's D6, the release stop).

**Acceptance criteria**
1. **Done-when** (`bench/pinned`, 40 dependencies): a second `check` within 5 minutes makes zero requests (the debug line, plus a tripwire proxy that records nothing), and the folder stays under its cap (`du -sk`).
2. **Location:** `ca.pixel-perfect.alwaysuptodate` in:
   - `~/Library/Caches/` on macOS (`XDG_CACHE_HOME` has no effect);
   - an absolute `$XDG_CACHE_HOME`, else `~/.cache`, on Linux and other Unixes;
   - `%LOCALAPPDATA%`, else `<home>\AppData\Local`, on Windows.

   `AUTD_CACHE_DIR` overrides them all.
3. **Derived values only.** No packument body is stored.
4. **The key** is kind + resolved registry URL (`registryFor(name, config)`, per manager's routing: #119, #120, #128) + name. Two registries never share an entry.
5. **No credentials.** No token, header value or derivation is written. A test greps every gunzipped entry for the token, the `Authorization` value and its base64 parts.
6. **The cap, atomicity and miss-on-unreadable hold.** A multi-process test covers concurrent writers.
7. **`depsDev: false`** reads and writes no deps.dev entry.
8. **The bypass:** `--no-cache` and `AUTD_NO_CACHE=1` touch nothing; `AUTD_CACHE_DIR` relocates the folder.
9. **Startup stays lean.** `startup.test.ts` proves `registryCache` doesn't load with the CLI, and the `--version` row stays within ±5 ms of `main`.
10. **#106's D6 bar.** Warm `check` and warm peak memory are at or below the roadmap's M3 baseline for npm, pnpm, yarn v1 and bun, or the PR says per row where and by how much they stay above.
11. **The matrix passes unchanged** on all five managers. It gains a second `check --json` per non-berry layout that a tripwire proxy proves made no request.

**Out of scope:** cooldown (#47, Q3), #107, #109, #110, a `cache clean` command (the README says to delete the folder), stale-if-error.

## Technical Architecture

No new dependencies. It uses `fs`, `path`, `zlib.gzipSync` / `gunzipSync`, and `crypto.createHash('sha256')` / `randomBytes`. `node:sqlite` was rejected: it prints an ExperimentalWarning on the floor versions, and M5's Bun binary lacks it.

| File                                            | Change  | Holds                                                                                                                           | Loads                                      |
| ----------------------------------------------- | ------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `src/utils/registryRequest.ts`                  | changed | `parseCacheControl()`, `CacheDirectives` (pure)                                                                                 | at startup, as today                       |
| `src/utils/registryClient.ts`                   | changed | `getResponse()` with `ifNoneMatch`, `RegistryResponse`; `getJson` built on it                                                   | lazily (unchanged)                         |
| `src/utils/registryDocuments.ts`                | changed | `export interface ParsedPackument`                                                                                              | with the reader                            |
| `src/utils/registryCache.ts`                    | new     | `cacheDirectory()`, `endpointKey()`, `freshFor()`, `createRegistryCache()`, `RegistryCache`, `TTL_SECONDS`, `DEFAULT_MAX_BYTES` | only via `await import()` from the session |
| `src/utils/registryReader.ts`                   | changed | consults the cache; lazy `client`; conditional requests; `stats()`                                                              | lazily (unchanged)                         |
| `src/utils/registry.ts`                         | changed | `RegistrySessionOptions.cache`; builds the cache with the reader; `close()` prunes and logs                                     | at startup; no new top-level imports       |
| `src/project.ts`                                | changed | `openProject(cwd, { pm, cache })`; `AUTD_NO_CACHE`                                                                              |                                            |
| `src/commands/options.ts`                       | changed | `noCacheOption()`                                                                                                               |                                            |
| `src/commands/check.ts`, `update.ts`            | changed | `--no-cache` → `{ cache: options.cache }`                                                                                       |                                            |
| `bench/targets.ts`                              | changed | `coldCaches` adds `AUTD_CACHE_DIR`                                                                                              |                                            |
| `__tests__/integration/harness.ts`, `matrix.ts` | changed | `AUTD_CACHE_DIR` in `managerEnv`; `runCliThroughTripwire`; the second-check test                                                |                                            |
| `__tests__/setup.ts`                            | changed | `process.env.AUTD_NO_CACHE = '1'`                                                                                               |                                            |

Barrel rule: keep `registryCache` out of `src/utils/index.ts` as a value; `export type` is fine.

### Client (Phase 1)

```ts
export type RegistryResponse =
  | { notModified: false; body: unknown; etag?: string; cacheControl?: string; authenticated: boolean }
  | { notModified: true; etag?: string; cacheControl?: string; authenticated: boolean }

export interface RegistryClient {
  /** As getJson, plus the validators. A 304 is returned only when `ifNoneMatch` was sent; otherwise it stays an error as today. */
  getResponse(url: string, registry: string, options?: {
    signal?: AbortSignal; accept?: string; timeout?: number; retries?: number; ifNoneMatch?: string
  }): Promise<RegistryResponse>
  getJson(...): Promise<unknown>   // unchanged; (await getResponse(...)).body; cooldown keeps using it
  stats(): ...; destroy(): void
}
```

- **`once()`** sends `if-none-match` when given, kept across redirects as `accept` is.
  - A 304 with `ifNoneMatch` set → `{ kind: 'not-modified', etag, cacheControl }`.
  - 2xx outcomes add `etag` and `cacheControl`.
- **`authenticated`** is `Boolean(authorization) || Boolean(credentials?.certfile && credentials?.keyfile)` per hop, ORed across redirects.
- **ETag guard:** keep `etag` only if it is at most 1024 characters of printable ASCII (`/^[\x21-\x7e][\x20-\x7e]*$/`); Node throws `ERR_INVALID_CHAR` otherwise.
- **`stats()`:** a 304 counts in `responses` with 0 bytes.

```ts
// src/utils/registryRequest.ts (pure)
export interface CacheDirectives { maxAge?: number; noStore: boolean; noCache: boolean; isPublic: boolean; isPrivate: boolean }
/** Case-insensitive, comma-separated; `max-age` a non-negative integer (quoted allowed); the smallest wins when repeated. */
export const parseCacheControl = (header: string | undefined): CacheDirectives
```

### Store (Phase 2, `src/utils/registryCache.ts`)

```ts
export const CACHE_FOLDER = 'ca.pixel-perfect.alwaysuptodate'
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024
export const TTL_SECONDS = { 'dist-tags': 300, 'deps.dev': 3600, packument: 300, 'packument-full': 300 } as const
export type CacheKind = keyof typeof TTL_SECONDS
export interface CacheValues {
  'dist-tags': { latest: string }
  'deps.dev': RegistryVersion[]
  packument: ParsedPackument
  'packument-full': ParsedPackument
}
export interface CachedEntry<K extends CacheKind> { value: CacheValues[K]; etag?: string; fresh: boolean }
export interface ResponseMeta { cacheControl?: string; etag?: string; authenticated: boolean }

export const cacheDirectory = (cwd: string, sources: Pick<NpmrcSources, 'env' | 'home' | 'platform'>): string | undefined
export const endpointKey = (url: string): string                       // protocol//host/path/, no userinfo/query/hash
export const freshFor = (kind: CacheKind, meta: ResponseMeta, sameForEveryone?: boolean): number | undefined
// 0 = only after a 304 (needs an ETag); undefined = don't store

export interface RegistryCache {
  readonly dir: string
  get<K extends CacheKind>(kind: K, endpoint: string, name: string): CachedEntry<K> | undefined   // a hit touches mtime
  put<K extends CacheKind>(kind: K, endpoint: string, name: string, value: CacheValues[K], meta: ResponseMeta, options?: { sameForEveryone?: boolean }): boolean
  stats(): { fresh: number; stale: number; missing: number; written: number; failedWrites: number; pruned: number }
  close(): void   // prunes when this run grew the folder; safe twice
}
export const createRegistryCache = (options: { dir: string; now?: () => number; maxBytes?: number }): RegistryCache
```

- **Entry file:** `gzip(JSON.stringify({ schema: 1, kind, key, name, storedAt, ttl, etag?, cacheControl?, authenticated, value }))`. It is fresh when `0 <= now - storedAt < ttl * 1000`.
- **The `freshFor` rules, in order:**
  1. `noStore` → undefined;
  2. `isPrivate || (authenticated && !sameForEveryone)` → `etag ? 0 : undefined`;
  3. `noCache || maxAge === 0` → `etag ? 0 : undefined`;
  4. otherwise `Math.min(TTL_SECONDS[kind], maxAge ?? Infinity) − Age`; a result of 0 or less is `etag ? 0 : undefined`.
- **Directory resolution:**
  - a non-empty `AUTD_CACHE_DIR` → `path.resolve(cwd, value)`;
  - darwin → `<home>/Library/Caches/<id>`;
  - win32 → `<LOCALAPPDATA or home\AppData\Local>\<id>`;
  - otherwise `<XDG_CACHE_HOME if absolute, else home/.cache>/<id>`;
  - no home → undefined.
- **Growth:** `put` does `statSync` before the rename (ENOENT counts as new) to decide whether the folder grew.

### Reader (Phase 3, `src/utils/registryReader.ts`)

```ts
export interface RegistryReaderOptions {
  registryConfig: RegistryConfig
  client: () => Promise<RegistryClient> // memoized by the session; called only when a request is needed
  depsDev: boolean
  endpoints?: RegistryEndpoints
  cache?: RegistryCache
}
export interface RegistryReader {
  lookup(name): Promise<PackageLookup>
  stats(): { notModified: number }
}
```

```
read(name):
  invalid → fail (no request)
  registry = registryFor(name, registryConfig)
  public = depsDev && isPublicNpmRegistry(registry, endpoints.publicRegistries)
  public && (depsDevUsable || cache?.get('deps.dev', endpoints.depsDev, name)?.fresh) → publicLookup
  else → packumentLookup

publicLookup(name, registry):
  tagsHit = cache?.get('dist-tags', registry, name); ddHit = cache?.get('deps.dev', endpoints.depsDev, name)
  [tags, dd] = await Promise.all([
    tagsHit?.fresh ? hit : fetch dist-tags,
    ddHit?.fresh   ? hit : depsDevVersions(name, ddHit?.etag),   // 304 → ddHit.value; 200 → put('deps.dev', …)
  ])
  dist-tags 404 → not-found (unchanged); no valid latest → packumentLookup
  a fetched dist-tags answer → put('dist-tags', registry, name, { latest }, meta, { sameForEveryone: dd listed the name })
  dd lists latest → found('deps.dev')
  dd came from a fresh entry and lacks latest → depsDevVersions(name) once more (decision 5); lists it → found
  else → packumentLookup(name, registry, latest)

packumentLookup(name, registry, expectedLatest?):
  for [accept, kind] of [[ABBREVIATED_ACCEPT, 'packument'], ['application/json', 'packument-full']]  // the second only after a 404
    hit = cache?.get(kind, registry, name)
    hit?.fresh && (expectedLatest === undefined || hit.value lists it) → use hit.value; stop
    fetched = get(url, registry, accept, { ifNoneMatch: hit?.etag })
    304 → put(kind, …, hit.value, meta); use hit.value
    200 → parsePackument; put(kind, …, parsed, meta); use parsed
    404 on the abbreviated request → next accept; otherwise as today
  rest unchanged
```

- A fresh packument entry lacking `expectedLatest` is revalidated, not trusted.
- `client()` is awaited only inside `get()`.
- Cache reads and writes run outside the limiter slots.

### Session, project, CLI (Phase 3)

```ts
// src/utils/registry.ts
export interface RegistrySessionOptions {
  // … unchanged fields
  cache?: { dir?: string; now?: () => number; maxBytes?: number }   // none when undefined (tests, --no-cache, AUTD_NO_CACHE=1)
}
// readerOnce: Promise.all([import('./registryReader'), options.cache ? import('./registryCache') : undefined]) → createRegistryCache({ dir: options.cache.dir ?? cacheDirectory(cwd, processSources()), … }) → createRegistryReader({ …, client, cache })
// close(): cache?.close(); one debug line (decision 13); then the client teardown. Idempotent.

// src/project.ts
export const openProject = (cwd, { pm, cache = true }: { pm?: SupportedPackageManager; cache?: boolean } = {}): Project
//   registry: createRegistrySession(cwd, { …, cache: cache && process.env.AUTD_NO_CACHE !== '1' ? {} : undefined })

// src/commands/options.ts
export const noCacheOption = (): Option => new Option('--no-cache', "Ask the registries instead of using autd's cache")
```

**Seams:**
- **#47:** a `times` kind (no TTL, merged on write, per-version answers only). The rule to keep: a cached time map never answers for a version it lacks, since a missing time fails cooldown open.
- **#107:** none needed.
- **#110:** `coldCaches` empties autd's cache.

## Implementation Phases

### Phase 1 — Client validators and header captures (no behavior change)

1. **Header captures,** before any code. No credentials and no `.npmrc`; the headers go to the scratchpad only:

   ```sh
   H=<scratchpad>/cache-headers; mkdir -p "$H"
   ABBREV='application/vnd.npm.install-v1+json; q=1.0, application/json; q=0.8, */*'
   hdr() { curl -sS --compressed -o /dev/null -D "$H/$1.headers" -H "Accept: $3" "$2"
           echo "== $1"; grep -iE '^(cache-control|etag|age|vary|last-modified):' "$H/$1.headers"; }
   for n in ms next @types%2fms; do f=${n//%2f/-}
     hdr "$f.dist-tags"      "https://registry.npmjs.org/-/package/$n/dist-tags" application/json
     hdr "$f.packument"      "https://registry.npmjs.org/$n" "$ABBREV"
     hdr "$f.packument-full" "https://registry.npmjs.org/$n" application/json
   done
   hdr ms.deps-dev       https://api.deps.dev/v3/systems/npm/packages/ms application/json
   hdr next.deps-dev     https://api.deps.dev/v3/systems/npm/packages/next application/json
   hdr yarnpkg.dist-tags https://registry.yarnpkg.com/-/package/ms/dist-tags application/json
   E=$(grep -i '^etag:' "$H/ms.packument.headers" | cut -d' ' -f2- | tr -d '\r')
   curl -sS -o /dev/null -w 'packument %{http_code}\n' -H "Accept: $ABBREV" -H "If-None-Match: $E" https://registry.npmjs.org/ms
   ```

   - Record per endpoint: `Cache-Control`, the ETag (weak or strong), `Age`, `Vary`, and the If-None-Match status. They go in a "Cache headers (2026-10-27)" table in `__tests__/fixtures/registry/README.md`, noting the Aikido proxy.
   - **Stop and report if** dist-tags carries `no-store`, `no-cache` or `max-age=0`.
2. **`parseCacheControl`** in `registryRequest.ts`.
3. **`getResponse`, `RegistryResponse` and `authenticated`** in `registryClient.ts`, with `getJson` built on `getResponse`.

**Tests**
- **`__tests__/utils/registryRequest.test.ts`:** `parseCacheControl` on the captured values; case, spaces and a quoted `max-age`; the smallest repeated `max-age`; garbage.
- **`__tests__/utils/registryClient.test.ts`:**
  - `etag` and `cache-control` are returned;
  - `if-none-match` is sent, and kept across a redirect;
  - a 304 with `ifNoneMatch` gives `notModified: true`, no body, and counts in `responses`;
  - a 304 without it still rejects;
  - `authenticated` is true with `_authToken`, `_auth`, URL userinfo and mTLS, and false with none;
  - an invalid ETag (CR/LF, over 1024 characters) is dropped;
  - every existing `getJson` case passes untouched.
- **Fixtures:** extend `Reply` in `__tests__/fixtures/registry.ts` with `headers?`, and add `conditional(reply, etag)`. Header values are opaque test strings; bodies stay the captured `.body` files.

**Gates:** the four standard gates. **Commit:** "Return ETags, Cache-Control and 304s from the registry client" (Refs #108).

### Phase 2 — The store

1. **`src/utils/registryCache.ts`,** as specified, with `ParsedPackument` named in `registryDocuments.ts`.
2. **`__tests__/fixtures/cacheWriter.ts`:** a child-process script that `put`s one key N times with distinct values. It runs as `process.execPath -r <repo>/bench/register.cjs __tests__/fixtures/cacheWriter.ts <dir> <n> <id>`.

**Tests** in `__tests__/utils/registryCache.test.ts`, on `fs.mkdtempSync` dirs with an injected `now`:
- **`cacheDirectory`:**
  - darwin, with `XDG_CACHE_HOME` set and ignored;
  - linux with an absolute XDG, a relative one (falls back to `~/.cache`) and none;
  - win32 with `LOCALAPPDATA`, and without it;
  - `AUTD_CACHE_DIR`, absolute and relative;
  - no home → undefined.
- **`endpointKey`:** userinfo, query and hash are dropped; the trailing slash is added; `https://registry.npmjs.org` equals `…org/`.
- **`freshFor`:** a table covering every rule in order, Q1's cases, and `sameForEveryone`.
- **Round trips:**
  - each kind comes back equal;
  - fresh at `ttl − 1 ms`, stale at `ttl`;
  - an entry with `storedAt` in the future is stale;
  - a stale entry is returned with `fresh: false` and its `etag`.
- **Misses:** a truncated gzip, non-JSON, `schema: 2`, a mismatched `name` or `endpoint`, a non-array deps.dev value, a version missing `deprecated`. None of them throws.
- **Separation:** two registries with the same name → two files; the kinds sit in separate directories.
- **No credentials:** `put` with `meta.authenticated` for a registry `https://user:SECRET@host/path/?token=Q` → no file contains `SECRET`, `Q` or `user:`.
- **Atomicity:**
  - a failed rename (the target is a directory) leaves the old entry readable and no `*.tmp` behind;
  - 4 children × 50 writes to one key while the test reads in a loop: every read is a valid entry, and no `*.tmp` is left.
- **Pruning:**
  - `maxBytes: 64 KiB` with 30 entries → `close()` deletes the oldest down to 80% or less;
  - a `get` refreshes a file's LRU order;
  - same-size rewrites don't scan;
  - a `*.tmp` older than 1 h is removed, a younger one is kept;
  - a user file is never deleted;
  - sizes count in 4 KiB units;
  - `CACHEDIR.TAG` is written once.
- **Fails open:** the folder path is a file, or (POSIX only, `it.skip` on win32) a `chmod 0o500` folder. `put` returns false, one debug line appears, and there are no further attempts.
- **POSIX modes:** directories `0o700`, files `0o600`.
- **Windows-safe:** take any filesystem root from the path under test, never `process.cwd()` (#124).

**Gates:** the four standard gates. **Commit:** "Keep registry answers in a size-capped cache under ca.pixel-perfect.alwaysuptodate" (Refs #108).

### Phase 3 — The reader on the cache, the switches, bench and harness

1. **`registryReader.ts`:** the flow above, the lazy `client`, `stats()`. Update `setup()` in `registryReader.test.ts` to pass `client: async () => client`.
2. **`registry.ts`:** the `cache` option, building the cache with the reader, and `close()`.
3. **`project.ts`, `options.ts`, `check.ts`, `update.ts`:** as specified. Add `--no-cache` to `src/commands/help.ts` if it lists options.
4. **`__tests__/setup.ts`:** `process.env.AUTD_NO_CACHE = '1'`.
5. **`bench/targets.ts`:** `coldCaches` adds `AUTD_CACHE_DIR: path.join(root, \`${target}-autd\`)`to`env`and to`dirs`; rewrite the "autd has no cache of its own yet" paragraph.
6. **`__tests__/integration/harness.ts`:**
   - `managerEnv` adds `AUTD_CACHE_DIR: path.join(scratch, 'autd-cache')` and deletes `AUTD_NO_CACHE`;
   - a new `runCliThroughTripwire(cwd, args)` starts `startProxy()` from `__tests__/fixtures/registry.ts`, sets `HTTPS_PROXY`, `HTTP_PROXY`, `https_proxy` and `http_proxy`, deletes `NO_PROXY` / `no_proxy` (keys found case-insensitively), and returns `{ output, seen }`.
7. **`__tests__/integration/matrix.ts`:** after the first `check --json`, add for every manager except berry `it('check --json again within the TTL asks no registry')`: the same output, and `seen` empty. `expectations.ts` stays untouched.

**Tests**
- **`__tests__/utils/registryReader.test.ts`, `describe('with the disk cache')`:** a temp dir, a `createRegistryCache` with a mutable `now`, and a new reader per "run".
  - run 2 within 300 s: zero requests, the same `RegistryPackage`, source `deps.dev`;
  - a fully fresh run never calls `client()`;
  - +301 s: one dist-tags request, no deps.dev;
  - +3601 s: both;
  - a dist-tags `latest` missing from a fresh deps.dev entry asks deps.dev once more (variants derived from captures); still missing → one packument request;
  - the packument path: 200 with an ETag → at +301 s `if-none-match` → 304 → the same versions, `bodyBytes` unchanged; a 200 with a new ETag replaces the entry;
  - a fresh packument entry lacking `expectedLatest` is revalidated;
  - an abbreviated 404 → the `packument-full` entry, with `publishedAt` surviving the cache;
  - `depsDev: false`: no deps.dev file is read or written;
  - Q1 (a):
    - authenticated and not `public`: dist-tags is not stored, unless deps.dev listed the name;
    - an authenticated packument with an ETag revalidates every run;
    - with `public`: served fresh;
  - `no-store` → not stored; `max-age=60` → a request at +61 s;
  - a failure with a stale entry gives `{ ok: false, kind: 'request' }`, never the stale value;
  - an unwritable cache dir gives the same results as no cache.
- **`__tests__/utils/registry.test.ts`:** no `cache` option → nothing written; `cache: { dir }` reaches the reader; `close()` prunes once, logs one line, and is safe twice and before any lookup.
- **`__tests__/project.test.ts`:** the default passes `cache: {}`; `{ cache: false }` passes `undefined`; `AUTD_NO_CACHE=1` passes `undefined`. Save and restore `process.env`.
- **`__tests__/commands/check.test.ts`, `update.test.ts`:** `--no-cache` reaches `openProject` as `cache: false`; without it, `cache: true`.
- **`__tests__/startup.test.ts`:** mock `@/utils/registryCache` and assert it isn't loaded.
- **`__tests__/bench/targets.test.ts`:** `env.AUTD_CACHE_DIR` is under the root, distinct per target, and in `dirs`.
- **Sweep:** `rg -n "createRegistryReader\(|openProject\(" src __tests__ bench`.

**Docs**
- **`CLAUDE.md`:**
  - the bench line (autd's cache is in `coldCaches`);
  - CLI Structure: `--no-cache`, `AUTD_NO_CACHE`, `AUTD_CACHE_DIR`;
  - a "Registry cache" bullet: folder per platform, kinds and TTLs, the Q1 rule, cap and LRU, atomic writes, fails open, no stale fallback, berry not covered;
  - Testing Notes: `setup.ts` sets `AUTD_NO_CACHE=1`, and the harness isolates with `AUTD_CACHE_DIR`.
- **`src/utils/CLAUDE.md`:** the file list; registry bullets (the store, `freshFor`, the reader's flow, the lazy client, the session's `cache` option); the guideline that the cache fails open, lookups report failures, and nothing ever falls back to a stale entry; the startup rule.
- **`src/commands/CLAUDE.md`:** `--no-cache`.
- **`.claude/context/ai-context/docs-overview.md`:** the new files.
- **`README.md`:** a "Cache" section: where the folder is, what it holds, that it holds nothing about credentials, TTLs, the 32 MiB cap, the switches, and that deleting it is safe.

**Gates:** the four standard gates plus the full matrix. **Commit:** "Answer repeat registry lookups from the cache, with --no-cache to bypass it" (Closes #108).

### Phase 4 — Real-run gates, then the PR

1. **Builds** in `<scratchpad>` worktrees: the pre-#106 build (e72a2ef, which #121 measured as `main`; confirm with `git rev-parse <#121's merge commit>^1`), and `main` without the cache. In each: `pnpm install && pnpm run build`.
2. **Bench, A-B-A-B on one machine, back to back:**

   ```sh
   AUTD_BENCH_PM=npm,pnpm,yarn,bun AUTD_BENCH_CLI=<scratchpad>/autd-pre106/dist/index.js pnpm run bench
   AUTD_BENCH_PM=npm,pnpm,yarn,bun pnpm run bench
   # twice; once more each with AUTD_BENCH_PROJECT=ranges; once with AUTD_BENCH_CLI=<scratchpad>/autd-main/dist/index.js to show the cache's own effect
   ```

   Pass bar (#106's D6): the branch's warm median and warm peak memory at or below both the roadmap's M3 baseline and the same session's pre-#106 build, per manager:

   | Manager      | Roadmap M3 baseline: warm / peak               | #121, pre-#106 `main`: warm / warm peak | #121, #106 branch: warm / warm peak |
   | ------------ | ---------------------------------------------- | --------------------------------------- | ----------------------------------- |
   | npm 11.19.1  | 0.92 s / 347 MB                                | 785, 793 ms / 379, 377 MB               | 676, 654 ms / 135, 153 MB           |
   | pnpm 12.14.0 | 0.25 s / 85 MB                                 | 909, 855 ms / 127, 135 MB               | 713, 663 ms / 140, 136 MB           |
   | yarn 1.22.22 | 2.65 s / 756 MB                                | 3.24, 2.54 s / 729, 757 MB              | 0.66, 1.49 s / 135, 135 MB          |
   | bun          | 0.16 s (1.4.0), 0.17 s (1.4.4) / 89 MB (1.4.0) | 534, 532 ms / 106, 109 MB               | 732, 975 ms / 138, 158 MB           |
   - **The roadmap's npm and pnpm memory figures** didn't come from hyperfine, and whether hyperfine's peak includes child processes is unconfirmed. If a row stays above, add `/usr/bin/time -l` maximum RSS for one warm run of each build, and state the gap and its cause in the PR.
   - **Reported only:** the 0.3 s warm budget, cold (at or below the #106 branch's 0.67–0.79 s, and under 1.0 s, noting the Aikido proxy), the startup row (±5 ms), and `cooldown 7, warm` (#47).
3. **The Done-when.** In a kept copy (`AUTD_BENCH_KEEP=1`, pnpm row) with `AUTD_CACHE_DIR=<scratchpad>/c108`:
   - **run 1:** `node dist/index.js check --json`;
   - **run 2, within 5 min:** with `{ "debug": true }` and the four proxy variables pointing at a tripwire (`<scratchpad>/tripwire.cjs`, a `node:http` server that logs any request or CONNECT and answers 502). Expect identical JSON, the debug line saying 80 fresh and `requests: none`, and an empty tripwire log;
   - **`du -sk "$AUTD_CACHE_DIR"`,** with file count and bytes per kind, against the 117–142 KB estimate and the cap;
   - **after `sleep 301`:** run 3 with debug: 40 dist-tags requests, 0 to deps.dev;
   - **`depsDev: false`, in a second dir:** the first run reads 40 packuments; run 2 within 5 min makes zero requests; after 301 s, 40 conditional requests. Report the 304 count (the issue measured 38 of 40) and the time (about 0.3 s);
   - **`--no-cache` and `AUTD_NO_CACHE=1`:** full network, with the folder's file list and mtimes unchanged;
   - **concurrency:** two `check` runs started together on an empty dir both succeed, a third makes no requests, and no `*.tmp` is left;
   - **Linux in Docker** (`node:24`, available on this machine): two runs; `ls ~/.cache/ca.pixel-perfect.alwaysuptodate/v1/*`, and with `XDG_CACHE_HOME=/tmp/x`.
4. **The full matrix,** all five managers on macOS.
5. **The PR,** through `/ship:pr`:
   - `Closes #108`;
   - What changed;
   - regression tests (the reader's "run 2 makes no request" and the matrix tripwire);
   - Gates;
   - Real run (the bench tables against both bars, the Done-when transcript, `du`, the `depsDev: false` 304 count);
   - user-visible changes;
   - the Q1–Q4 decisions, for veto;
   - Not verified: Windows' default folder, authenticated npmjs `Cache-Control`, private registries' headers, very large monorepos near the cap.

## Design Considerations

- **Performance:** a warm run reads about 80 small gzipped files (a few ms), parses about 1.47 MB of JSON and loads no TLS stack. A cold run adds about 80 sync gzip+rename pairs, a few ms. Pruning scans only when the folder grew.
- **Memory:** no raw deps.dev document (4.5 MB decoded for the 40) is parsed on a warm run, and that was #106's extra 30 MB.
- **Startup:** `registryCache` loads only through the session's `await import()`, and `registry.ts` gains no top-level import.
- **Privacy:**
  - nothing about credentials is stored;
  - Q1 decides what an authenticated answer may serve;
  - the folder is `0o700`;
  - deps.dev entries hold only public data, and `depsDev: false` stops reading them.
- **Windows:** `%LOCALAPPDATA%` is the default; a rename that fails under a lock is a skipped write; paths stay under `MAX_PATH`; tests inject `platform`, and the windows-latest CI covers the rest.

## Risks & Mitigation

1. **A just-published `latest` is unseen for up to 300 s plus the CDN's age.** Documented; `--no-cache` asks again.
2. **Credentials crossing projects:** Q1 (a). A non-public authenticated answer is never served without the registry's 304.
3. **dist-tags turns out uncacheable** (Phase 1's capture): stop and report.
4. **The Aikido proxy rewrites or drops validators:** entries become TTL-only. CI's tripwire test runs without the proxy.
5. **The memory bar is unreachable as written** (pnpm's 85 MB came from another method): the second tool's figure and a per-row statement go in the PR.
6. **Concurrent runs, crashes, a full or read-only disk:** atomic renames, misses on bad entries, temp-file cleanup, fail-open writes.
7. **The test suite touches the developer's cache:** the session default is off, `setup.ts` sets `AUTD_NO_CACHE=1`, and the harness and bench use `AUTD_CACHE_DIR`.
8. **The folder grows past the cap between scans:** a run that grows it scans at `close()`.
9. **deps.dev lag:** decision 5, plus ETag-cached packuments.
10. **Merge conflicts with #128, #118 and #122:** docs only, plus `project.ts` with #128. Merge `main` in before handover.
