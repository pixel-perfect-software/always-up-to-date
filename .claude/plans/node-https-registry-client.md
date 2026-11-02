# Native `node:https` registry client and `.npmrc` loader

Issue: #46 (fixes #104). Branch: `feat/46-104-node-https-client`. Milestone: M3. Planned 2026-10-26.

- [x] Phase 1: `.npmrc` parser and layered loader (removes `ini`)
- [x] Phase 2: `node:https` client, new `RegistryConfig`, lazy load (removes `npm-registry-fetch`, fixes #104)
- [x] Phase 3: Node floor, CI on Node 22, docs

Each phase leaves `pnpm run check-types`, `pnpm run format-and-lint`, `pnpm test` and `pnpm run build` green. Don't commit; the orchestrator commits per phase.

## Overview

**Goal.** Remove `npm-registry-fetch` and `ini`. Replace them with a small `.npmrc` parser, a layered loader that resolves `.npmrc` as npm 12 does, and a lazily loaded `node:https` client that honors scoped registries, per-prefix auth, TLS, proxies, retries, timeouts and `maxsockets`. Then lower `engines.node` to `^22.23.0 || >=24.17.0` and add Node 22 to CI.

**Acceptance criteria (#46's Done when):**
1. Tests against local servers cover each setting: auth by the longest prefix (`_authToken`, `_auth`, `username` + `_password`, `certfile` + `keyfile`); `ca`, `ca[]`, `cafile`, `strict-ssl`; `https-proxy`, `proxy`, `noproxy` over `HTTPS_PROXY` / `https_proxy` / `NO_PROXY` with suffix matching; `fetch-retries` with backoff and `Retry-After`, `fetch-timeout`, `maxsockets`; layering (`npm_config_*`, project, userconfig, global); scoped registries (#104).
2. `engines.node` is `^22.23.0 || >=24.17.0`, and CI is green on Node 22 and 24.
3. Neither `npm-registry-fetch` nor `ini` is a dependency (drop `@types/ini` and `@types/npm-registry-fetch` too).
4. `--version` and `help` never load the client (`src/index.ts` → `cli` → commands → `@/utils` barrel must not reach it).
5. Cooldown otherwise unchanged:
   - it still fails open (empty time map plus a debug line);
   - the in-flight request cache per run stays;
   - `fetchReleaseTimes(name, config)` and `clearRegistryCache()` keep their names (about 6 test files mock `@/utils/registry` by those names).

**Stack.** TypeScript 7 (`tsc` + `tsc-alias`), CommonJS output, Jest 30 + `@swc/jest`, Biome 2, pnpm 12. Imports follow the repo's style (`import fs from 'fs'`, not `node:fs`). Biome forbids `require` in `src` (`noCommonJs`), so lazy loading uses `await import()`, which tsc compiles to `require` (as `src/index.ts:5` does).

**Sources checked:**
- Node 24 docs, `http.html#built-in-proxy-support`:
  - `proxyEnv` reads `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY`; the lower-case key wins when both are set.
  - `NO_PROXY` accepts `*`, an exact host, `.suffix`, `*.suffix`, an IP, an IP range and `host:port`.
  - Stability 1.1.
- `@types/node` 26.6.5 has `AgentOptions.proxyEnv` (`http.d.ts:1579`).
- Reference implementations to port from, in the local npm 11.19.1 install (logic matches npm 12.2.1), under `~/.asdf/installs/nodejs/24.22.1/lib/node_modules/npm/node_modules/`:
  - `@npmcli/config/lib/{index.js,env-replace.js,parse-field.js,nerf-dart.js}`
  - `npm-registry-fetch/lib/{auth.js,index.js}`
  - `@npmcli/agent/lib/proxy.js`
- ini 7.0.0 source: `node_modules/.pnpm/ini@7.0.0/node_modules/ini/lib/ini.js`. Read it before Phase 1 removes it.
- ini tests to port (ISC): https://github.com/npm/ini/tree/v7.0.0/test (`foo.js`, `bar.js`, `duplicate-properties.js`, `proto.js`, `win32.js`, plus `fixtures/`).
- `main`'s branch protection requires no status checks (`required_status_checks.contexts` is `[]`, checked 2026-10-26). Renamed CI jobs can't block merging, but keep the old names anyway.

**Ship.** One branch, one PR ("Closes #46, closes #104", milestone M3). Each phase is one or more commits that leave the gates green.

## Technical Architecture

### Module layout (flat in `src/utils/`)

| File                           | Status    | Loads at startup?                                                           | Responsibility                                                                                                                                                    |
| ------------------------------ | --------- | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/utils/npmrc.ts`           | new       | yes (cheap, pure)                                                           | `parseNpmrc(text, env)`, `substituteEnv(text, env)`, the `Npmrc` types. Replaces `ini`                                                                            |
| `src/utils/npmrcLoader.ts`     | rewritten | yes                                                                         | Layering (`loadNpmrc`), `registryConfigFrom`, `loadRegistryConfig`, `npmrcBoolean`, `NpmrcSources`, `processSources()`                                            |
| `src/utils/registryRequest.ts` | new       | yes (pure, no Node I/O modules)                                             | `registryFor`, `packumentUrl`, `credentialPrefixes`, `credentialsFor`, `authorizationFor`, `isRetryableStatus`, `isRetryableError`, `retryDelay`, retry constants |
| `src/utils/registryClient.ts`  | new       | **no**: loaded only by `registry.ts` via `await import('./registryClient')` | Transport: one keep-alive Agent per registry, gzip, timeout, retries, redirects                                                                                   |
| `src/utils/registry.ts`        | rewritten | yes (only type imports, logger and `registryRequest`)                       | `fetchReleaseTimes` (in-flight cache, fails open), `clearRegistryCache` (also destroys clients)                                                                   |

`src/utils/index.ts` keeps exporting `loadRegistryConfig`, `clearRegistryCache` and `fetchReleaseTimes`. That is safe because `registry.ts` no longer imports anything heavy at the top level. It may import `type { RegistryClient } from './registryClient'`, since `import type` is erased.

### Types (`src/types.ts`, Phase 2)

Replace `RegistryConfig`. `authTokens`, `alwaysAuth` and `cafile` go away; npm 12 has no `always-auth`.

```ts
/** What one `//host[:port]/path/:` prefix of .npmrc holds. */
export interface RegistryCredentials {
  authToken?: string // _authToken → Bearer
  auth?: string // _auth (base64 user:pass) → Basic, unchanged
  username?: string
  password?: string // _password, base64 as .npmrc stores it
  certfile?: string // absolute, resolved against cwd
  keyfile?: string // absolute, resolved against cwd
}

/** The Agent's proxyEnv, already resolved from .npmrc and the environment.
 *  A type alias: an interface isn't assignable to http.ProxyEnv's index signature. */
export type ProxySettings = {
  HTTPS_PROXY?: string
  HTTP_PROXY?: string
  NO_PROXY?: string
}

export interface RegistryConfig {
  registry: string // default https://registry.npmjs.org/
  scopedRegistries: Record<string, string> // '@scope' → URL
  credentials: Record<string, RegistryCredentials> // '//host[:port]/path/' (as written) → fields
  ca?: string[] // cafile (if readable) else ca / ca[]; undefined = Node's default store
  strictSSL: boolean // default true
  proxy: ProxySettings
  fetchRetries: number // default 2
  fetchTimeout: number // ms; unset → 300000; 0 → 30000 (npm-registry-fetch's `timeout || 30*1000`)
  maxSockets: number // default 15
}
```

### Parser (`src/utils/npmrc.ts`): ini 7's `decode` plus npm's env-replace

```ts
export type NpmrcScalar = string | boolean | null
export type NpmrcValue = NpmrcScalar | NpmrcScalar[]
export type Npmrc = Record<string, NpmrcValue>   // built with Object.create(null)
export const substituteEnv: (text: string, env: NodeJS.ProcessEnv) => string
export const parseNpmrc: (text: string, env: NodeJS.ProcessEnv) => Npmrc
```

Rules, all decided:

- **Lines.** Split on `/[\r\n]+/`. Skip blank lines and lines matching `/^\s*[;#]/`. Match each line against ini's `/^\[([^\]]*)\]\s*$|^([^=]+)(=(.*))?$/`. A section match **stops parsing**. A line that matches neither alternative is skipped.
- **Keys and values** both go through ini's `unsafe`:
  - Trim.
  - A double-quoted value is `JSON.parse`d; if that fails, the raw value is kept, quotes included, as ini does.
  - A single-quoted value has its quotes stripped. This deviates slightly from ini, which then `JSON.parse`s the inner text: here `'123'` stays a string.
  - An unquoted value is cut at the first unescaped `;` or `#`. Then `\;`, `\#` and `\\` are unescaped, any other `\x` is kept as is, and the result is trimmed.
- **Keys without values.** A key with no `=` is `true`. `true`, `false` and `null` become those JS values, checked before env substitution.
- **Arrays.** `key[]` is an array.
  - Detect `[]` on the unquoted key _before_ substitution, then strip it.
  - ini's safeguard: a plain key after an array key, or an array key after a plain key, appends.
  - Otherwise, for a repeated plain key, the last wins.
- **Prototype.** Skip the key `__proto__`; use a null-prototype object.
- **`substituteEnv`** is a verbatim port of `@npmcli/config/lib/env-replace.js`. It runs after unquoting, on keys and on each string value and array element.
  - Regex: `/(?<!\\)(\\*)\$\{([^${}?]+)(\?)?\}/g`.
  - An unset `${VAR}` stays literal. This deliberately changes today's loader, which makes it `''`.
  - `${VAR?}` becomes `''`.
  - An odd run of backslashes escapes the reference, and half of the backslashes are consumed.

### Loader (`src/utils/npmrcLoader.ts`)

```ts
export interface NpmrcSources { env: NodeJS.ProcessEnv; home: string; execPath: string; platform: NodeJS.Platform }
export const processSources = (): NpmrcSources =>
  ({ env: process.env, home: process.env.HOME || os.homedir(), execPath: process.execPath, platform: process.platform })
// Call-time defaults, not module-load time.
export const loadNpmrc = (cwd: string, sources = processSources()): Npmrc
export const npmrcBoolean = (value: unknown): boolean | undefined     // unchanged contract
export const registryConfigFrom = (npmrc: Npmrc, cwd: string, sources: NpmrcSources): RegistryConfig   // Phase 2
export const loadRegistryConfig = (cwd: string, sources = processSources()) =>
  registryConfigFrom(loadNpmrc(cwd, sources), cwd, sources)
```

`loadNpmrc` merges four layers; later wins: global, then user, then project, then env.

1. **Env layer** (`envConfig(env)`):
   - A key matches `/^npm_config_/i`; empty values are skipped.
   - The prefix is sliced off. Unless the rest starts with `//`, `.replace(/(?!^)_/g, '-').toLowerCase()` is applied.
   - Values go through `substituteEnv`.
2. **Project root** (`findNpmProjectRoot(cwd)`), ported from `loadLocalPrefix`:
   - Walk up from `cwd`. The first directory with `package.json` (a file) or `node_modules` (a directory) is the local prefix.
   - Keep walking. An ancestor whose `package.json` has `workspaces` and whose member list contains the local prefix becomes the project root, and the walk returns.
   - Reuse `readManifest`, `workspacePatterns` and `readWorkspaceManifests` from `@/managers/workspaces`; compare `toPosix(path.relative(ancestor, localPrefix))` with the member paths.
   - With no match, the root is the local prefix, else `cwd`. Stop when `path.dirname(dir) === dir`.
   - This adds a utils → managers import with no cycle (`workspaces.ts` imports only `@/utils/logger` and `@/stepError`). A member's own `.npmrc` is then ignored, as npm does.
3. **Paths** (`resolveNpmPath(value, home, cwd, platform)`): `~/` (and `~\` on win32) resolves against `home`; anything else goes through `path.resolve(cwd, value)`. Used for `userconfig`, `globalconfig` and `cafile`.
4. **Userconfig.**
   - Before reading the project file, compute `env.userconfig ?? '~/.npmrc'`; if the project `.npmrc` path equals that path, skip the project file (npm's guard).
   - After the project file: `userconfig = env.userconfig ?? project.userconfig ?? '~/.npmrc'`.
5. **Global.**
   - `globalconfig = env.globalconfig ?? project.globalconfig ?? user.globalconfig ?? <prefix>/etc/npmrc`.
   - The prefix is `env.PREFIX` (the raw environment variable), else `dirname(execPath)` on win32, else `dirname(dirname(execPath))`.
   - Not supported: `DESTDIR` and `prefix` from config.
6. **Reading files.** Read with `fs.readFileSync`; an unreadable file is an empty layer, which keeps today's fail-open behavior. Merge with `Object.assign(Object.create(null), global, user, project, envLayer)`.

`registryConfigFrom` (Phase 2):
- **`registry`:** the string value, else `https://registry.npmjs.org/`.
- **`scopedRegistries`:** keys matching `/^@[^:]+:registry$/`.
- **`credentials`:**
  - Every key that starts with `//` and whose part after the **last** `:` is one of `_authToken`, `_auth`, `username`, `_password`, `certfile`, `keyfile`.
  - The prefix is everything before that `:`; the port's colon stays in the prefix. Only string values count.
  - `certfile` and `keyfile` become `path.resolve(cwd, value)`.
  - Unscoped `_authToken`, `_auth`, `username` and `_password` (no `//` prefix) are ignored; npm 9+ rejects them.
- **`ca`:**
  - If `cafile` is set and readable, read it and split at each `-----END CERTIFICATE-----` (`replace(/\r\n/g,'\n').split(delim).filter(s => s.trim()).map(s => s.trimStart() + delim)`). It wins over `ca`.
  - Otherwise `ca` as a string becomes `[s]`, and `ca[]` gives its string elements. With neither, `undefined`.
  - A missing or unreadable `cafile` falls back to `ca`, with a debug log.
- **`strictSSL`:** `npmrcBoolean(npmrc['strict-ssl']) ?? true`.
- **`proxy`** (npm-registry-fetch's `proxy: httpsProxy || proxy`, with `@npmcli/agent`'s environment fallback):
  - `configured = string(npmrc['https-proxy']) ?? string(npmrc.proxy)`.
  - `HTTPS_PROXY = configured ?? env.https_proxy ?? env.HTTPS_PROXY`.
  - `HTTP_PROXY = configured ?? env.http_proxy ?? env.HTTP_PROXY`.
  - `noproxy` comes from `.npmrc` (a string, or a `noproxy[]` array joined with `,`), else `env.no_proxy ?? env.NO_PROXY`. Split on `,` and trim. For each entry starting with neither `.` nor `*`, also add `.entry` (npm's suffix matching). Set `NO_PROXY` only when non-empty.
  - Omit unset keys. Never copy the raw environment in, or Node's lower-case keys would override.
- **Numbers:**
  - `fetch-retries`: integer ≥ 0, default 2.
  - `fetch-timeout`: unset → 300000, 0 → 30000, a positive integer → itself.
  - `maxsockets`: integer ≥ 1, default 15.

The npm and bun adapters (`src/managers/npm/index.ts:161`, `src/managers/bun/index.ts:237`) keep calling `loadNpmrc(cwd)` and `npmrcBoolean(...)` unchanged. They now see the full layering, including the workspace root's `.npmrc`.

### Request helpers (`src/utils/registryRequest.ts`, pure)

- **`registryFor(name, config)`:** for a scoped name, `config.scopedRegistries[name.slice(0, name.indexOf('/'))]`; otherwise, or when there's no scope registry, `config.registry`.
- **`packumentUrl(name, registry)`:** `${registry.trim().replace(/\/?$/, '')}/${name.replace('/', '%2f')}`. Only the first `/` is replaced, like npm-package-arg's `escapedName`.
- **`credentialPrefixes(url)`:** start from `//${url.host}${url.pathname}`, then repeatedly apply `.replace(/([^/]+|\/)$/, '')` while the length is greater than 2 (npm-registry-fetch's `regFromURI` walk). `URL.host` keeps a non-default port, so the port counts.
- **`holdsCredential(c)`:** `authToken || auth || (username && password) || (certfile && keyfile)` (npm's `hasAuth`).
- **`credentialsFor(url, registry, credentials)`:** the first prefix in the walk that holds a credential, with every field read from that prefix only. If none matches, `url.host === new URL(registry).host` and the URLs differ, repeat with the registry URL. Otherwise `undefined`.
- **`authorizationFor(c)`:**
  - a token → `Bearer <token>`;
  - else `_auth` → `Basic <auth>`, unchanged;
  - else username + password → `Basic base64(username + ':' + base64decode(password))`;
  - otherwise `undefined`.
- **Retries:**
  - `isRetryableStatus(s)`: `s === 408 || s === 420 || s === 429 || s >= 500`.
  - `isRetryableError(e)`: `code` is one of `ECONNRESET`, `ECONNREFUSED`, `ETIMEDOUT`. `ENOTFOUND` is not retried.
  - `RETRY_BASE_MS = 100`, `RETRY_MAX_MS = 1000`.
  - `retryDelay(attempt, retryAfterHeader, now)`:
    - Parse `Retry-After` as integer seconds, or as an HTTP-date minus `now`, floored at 0.
    - If that delay is ≤ `RETRY_MAX_MS`, use it. If larger, return `undefined` (stop retrying: never retry earlier than the server asked, and keep the 1 s budget).
    - With no header, return `min(RETRY_BASE_MS * 2 ** attempt, RETRY_MAX_MS)`.

### Client (`src/utils/registryClient.ts`, lazily loaded)

```ts
export interface RegistryClient {
  /** GET url as JSON with the credentials and agent for its registry; rejects with RegistryRequestError. */
  getJson(url: string, registry: string, options?: { signal?: AbortSignal }): Promise<unknown>
  destroy(): void
}
export interface RegistryClientOptions {
  sleep?: (ms: number) => Promise<void>   // default: setTimeout from 'timers/promises'; tests record delays
  lookup?: net.LookupFunction             // test seam: resolve test hostnames to 127.0.0.1
}
export class RegistryRequestError extends Error { code?: string; status?: number }   // never carries header values
export const createRegistryClient = (config: RegistryConfig, options?: RegistryClientOptions): RegistryClient
```

**Agents.** One keep-alive Agent per registry, created on first use.
- Map key: `` `${url.protocol}//${url.host} ${creds?.certfile ?? ''} ${creds?.keyfile ?? ''}` ``. One agent per registry; a redirect to another host gets its own.
- `https:` uses `https.Agent` with:
  - `keepAlive: true`, `maxSockets: config.maxSockets`, `rejectUnauthorized: config.strictSSL`;
  - `ca` only when `config.ca` is defined;
  - `cert` and `key` from `fs.readFileSync(path, 'utf8')`, only when the matched credentials hold both;
  - `proxyEnv: config.proxy`, only when `HTTPS_PROXY` or `HTTP_PROXY` is set;
  - `lookup` when given.
- `http:` uses `http.Agent` with the same options minus TLS. npm-registry-fetch served http registries such as a local Verdaccio.
- Don't use `agentKeepAliveTimeoutBuffer`: it was added in 24.7 and isn't in Node 22.

**One attempt.**
- Strip any userinfo from the URL; it is never sent or logged.
- `(https|http).request(url, { agent, headers, signal })`, with headers:
  - `accept: application/json` (the full packument, which has `time`);
  - `accept-encoding: gzip`;
  - `user-agent: always-up-to-date/<version> node/<process.version> <platform> <arch>`, the version from the package.json import as in `src/cli.ts:16` (from `src/utils/` that is `../../package.json`);
  - `authorization` when `authorizationFor` gives one.
- `signal` is `AbortSignal.any([AbortSignal.timeout(config.fetchTimeout), ...caller])`. The deadline covers headers and body.
- **2xx:** `pipeline(res, ...(content-encoding is gzip ? [zlib.createGunzip()] : []), async function* (src) { for await (const c of src) chunks.push(c) })` from `stream/promises`, then `JSON.parse(Buffer.concat(chunks).toString('utf8'))` as `unknown`. A `content-encoding` other than gzip or identity is an error, as is invalid JSON; neither is retried.
- **3xx with `Location`:** drain (`res.resume()`), resolve the location against the URL and loop, at most 5 redirects. Recompute the credentials and the agent for the new URL, so a token goes only where `.npmrc` scopes it. Refuse a redirect from `https:` to `http:`.
- **Other status:** drain, and return the status and `retry-after`.
- When the timeout signal aborted, rethrow as `code: 'ETIMEDOUT'` so it is retried.

**Retry loop**

```
for attempt = 0..:
  try outcome = await once(url)
  catch e: if attempt < fetchRetries && isRetryableError(e) → await sleep(retryDelay(attempt)); continue; else throw
  json → return; redirect → follow (separate counter)
  if attempt < fetchRetries && isRetryableStatus(status):
     d = retryDelay(attempt, retryAfter, Date.now()); if d !== undefined → await sleep(d); continue
  throw new RegistryRequestError(`GET ${redactedUrl}: ${status} ${statusMessage}`, …)
```

**`destroy()`** destroys every agent. Node unrefs free keep-alive sockets, so the CLI exits without calling it.

### `fetchReleaseTimes` (`src/utils/registry.ts`)

- Keep `releaseTimeCache: Map<string, Promise<Record<string, string>>>` and the `fetchReleaseTimes(packageName, config)` signature.
- Add `clients: Map<RegistryConfig, RegistryClient>`. The async `clientFor(config)`:
  - checks the map;
  - otherwise runs `const { createRegistryClient } = await import('./registryClient')`;
  - **re-checks the map after the await** (concurrent callers), then creates and stores the client.
- `requestReleaseTimes`, all inside `try`:
  - `const registry = registryFor(name, config)`;
  - `client.getJson(packumentUrl(name, registry), registry)`;
  - narrow with a plain-object check and keep only the string entries of `time`;
  - on any error, `logger.debug(\`Failed to fetch registry metadata for ${name}: ${message}\`)`and return`{}`.
- `clearRegistryCache()` clears both maps and calls `destroy()` on each client.
- No other call site changes. `releaseAges.ts` and `filterPackages.ts` keep calling `loadRegistryConfig(cwd)` only when cooldown is on. Their second lookup in an `update` run hits the name cache, so only one client is created.

## Phase 1: `.npmrc` parser and layered loader (removes `ini`)

**Tasks**
1. `src/utils/npmrc.ts`: the parser and `substituteEnv` above.
2. `src/utils/npmrcLoader.ts`: `NpmrcSources`, `processSources`, `envConfig`, `findNpmProjectRoot`, `resolveNpmPath`, layered `loadNpmrc`, `npmrcBoolean`.
   - Keep `loadRegistryConfig`'s **old return shape** for now (`registry`, `scopedRegistries`, `authTokens`, `alwaysAuth`, `strictSSL`, `ca`, `cafile`), read from the new `loadNpmrc`.
   - Remove `substituteEnvVars` and `ENV_VAR_PATTERN`; the parser already substituted.
   - `npm-registry-fetch` keeps working unchanged this phase.
3. Remove `ini` from `package.json` and the `pnpm-workspace.yaml` catalog, and `@types/ini` from both. Run `pnpm install` and keep `pnpm-lock.yaml`.
4. Tests:
   - **New `__tests__/utils/npmrc.test.ts`.**
     - Header: "Cases ported from ini 7.0.0's test suite", followed by the full ISC license notice (ISC requires it).
     - Port every decode case from `foo.js`, `bar.js`, `duplicate-properties.js`, `proto.js` and `win32.js` that touches top-level keys: quoting, `;`/`#` cuts, escapes, `key[]`, the array safeguard, `true`/`false`/`null`, `=` inside values, empty values, a key without `=`, CRLF, `__proto__`. Section cases become "parsing stops at the first `[section]`".
     - npm env-replace cases: `${VAR}`, `${VAR?}`, an unset `${VAR}` stays literal, `\${VAR}` and `\\${VAR}`, substitution in keys, in values and in array elements.
   - **Rewrite `__tests__/utils/npmrcLoader.test.ts`** on real temp dirs instead of `jest.mock('fs')`/`jest.mock('os')`.
     - Build sources with a helper `sourcesFor(tmp, env = {})` → `{ env, home: tmp/home, execPath: tmp/prefix/bin/node, platform: process.platform }`.
     - Precedence per key: env > project > user > global.
     - `npm_config_*` in any case; empty values skipped; `_` → `-` except a leading `_`; `//` keys verbatim.
     - The walk up from `<proj>/src` to the `package.json` dir, and a `node_modules`-only marker.
     - From a workspace member, the root's `.npmrc` is used and the member's ignored; without a `workspaces` field, the member's is used.
     - `npm_config_userconfig`, and `userconfig` set in the project `.npmrc`.
     - `PREFIX/etc/npmrc`; the posix (`dirname(dirname)`) and win32 (`dirname`) branches through injected `platform`, with paths built by `path.join` so they work on both hosts.
     - `npm_config_globalconfig`.
     - An unset `${VAR}` stays literal.
   - **Hermeticity.**
     - Add `isolateNpmConfig(dir)` to `__tests__/fixtures/index.ts`, shaped like `prependPath`. It deletes `npm_config_*` keys case-insensitively, sets `HOME` and `PREFIX` to `dir`, spies `os.homedir`, and returns a restore function.
     - Use it in `__tests__/utils/saveStyle.test.ts`: its `jest.spyOn(os, 'homedir')` no longer suffices, because `HOME` is read first and the global npmrc is now read.
     - Use it in every test file that reaches an adapter's `saveStyle` or `apply`. Grep for `saveStyle(` and `.apply(`; at least `applyRanges`, `workspaceApply` and `pipeline`.
     - Don't put it in `__tests__/setup.ts`: `jest.integration.config.ts` inherits that file and spawns real managers.
   - On Windows, write paths into test `.npmrc` files JSON-quoted (`cafile=${JSON.stringify(file)}`), so backslashes survive the parser.

**Gates:** `pnpm run check-types`, `pnpm run format-and-lint`, `pnpm test`, `pnpm run build`.

## Phase 2: `node:https` client, new `RegistryConfig`, lazy load (removes `npm-registry-fetch`, fixes #104)

**Tasks**
1. `src/types.ts`: the new `RegistryCredentials`, `ProxySettings` and `RegistryConfig`.
2. `src/utils/npmrcLoader.ts`: `registryConfigFrom` and the new `loadRegistryConfig`.
3. `src/utils/registryRequest.ts`, `src/utils/registryClient.ts`, and the rewritten `src/utils/registry.ts`, as designed above.
4. Remove `npm-registry-fetch` and `@types/npm-registry-fetch` from `package.json` and the catalog.
   - Then run `pnpm why http-cache-semantics` and `pnpm why ip-address`, and drop each override in `pnpm-workspace.yaml` that no longer matches anything (both came in through the npm-registry-fetch tree). Keep `brace-expansion` if `pnpm why` still finds it.
   - `pnpm install`, keep the lockfile.
   - Grep `src/` and `__tests__/` for `npm-registry-fetch` and `from 'ini'`: zero hits.
5. TLS fixtures in `__tests__/fixtures/tls/`: commit `ca.pem`, `server.pem`, `server.key`, `client.pem`, `client.key` and `generate.sh`; don't commit `ca.key`.
   - Node can't create X.509 certificates and Windows runners shouldn't need openssl, so the PEMs are committed.
   - The server certificate's SAN is `DNS:localhost, IP:127.0.0.1`. Tests use `127.0.0.1` URLs to avoid `::1` on Windows.
   - `generate.sh` (POSIX sh plus `openssl x509 -req -extfile`, which works with LibreSSL and OpenSSL 3):

   ```sh
   #!/bin/sh
   # Test-only TLS material for the registry client tests. Valid 100 years. Rerun to regenerate.
   set -eu; cd "$(dirname "$0")"; tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
   printf '[req]\ndistinguished_name=dn\n[dn]\n[v3_ca]\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,keyCertSign,cRLSign\n' > "$tmp/ca.cnf"
   openssl ecparam -name prime256v1 -genkey -noout -out "$tmp/ca.key"
   openssl req -x509 -new -key "$tmp/ca.key" -sha256 -days 36500 -subj "/CN=autd test CA" -config "$tmp/ca.cnf" -extensions v3_ca -out ca.pem
   leaf() { openssl ecparam -name prime256v1 -genkey -noout -out "$1.key"
     openssl req -new -key "$1.key" -subj "/CN=$2" -out "$tmp/$1.csr"
     printf 'basicConstraints=CA:FALSE\nkeyUsage=critical,digitalSignature\nextendedKeyUsage=%s\n%s' "$3" "${4:+subjectAltName=$4\n}" > "$tmp/$1.ext"
     openssl x509 -req -in "$tmp/$1.csr" -CA ca.pem -CAkey "$tmp/ca.key" -CAcreateserial -CAserial "$tmp/ca.srl" -days 36500 -sha256 -extfile "$tmp/$1.ext" -out "$1.pem"; }
   leaf server localhost serverAuth "DNS:localhost,IP:127.0.0.1"
   leaf client "autd test client" clientAuth
   ```

6. Server helpers in `__tests__/fixtures/registry.ts`, seeded from `/private/tmp/claude-501/-Users-tylerrobertson-personal-dev-always-up-to-date/5c5b5f9d-782c-4110-8aa6-c9341278028d/scratchpad/tlsscripts/t.js` and `nrf.js`:
   - `startRegistry(handler, { tls?: 'server' | 'mtls' })` returns `{ url, port, requests: { url, headers }[], connections, close }`. It binds `127.0.0.1:0`; `close()` calls `closeAllConnections()`, then `close()`.
   - `startProxy()`: a plain HTTP server that records `GET` absolute URIs and `CONNECT host:port` with `proxy-authorization`, and tunnels CONNECT with `net.connect`.
   - `readTls(name)`.
7. Tests (all local, no network, ubuntu and windows):
   - **New `__tests__/utils/registryRequest.test.ts`** (pure):
     - `packumentUrl` escaping and registry-path joining; `registryFor` by scope.
     - The prefix walk, longest-prefix match, the port counts, and the same-host fallback to the registry.
     - A deeper prefix holding only `certfile` + `keyfile` beats a host token, and every field comes from that prefix. A lone `username` doesn't count.
     - The three Authorization forms.
     - `retryDelay`: backoff, Retry-After in seconds and as a date, over the cap returns `undefined`. `isRetryableError` for `ENOTFOUND` is false.
   - **New `__tests__/utils/registryClient.test.ts`**: build configs with `registryConfigFrom(...)` and inject `sleep: (ms) => { delays.push(ms); return Promise.resolve() }`. Cases in the coverage matrix below.
   - **Rewrite `__tests__/utils/registry.test.ts`** against local servers:
     - in-flight dedupe: the server sees one request for three calls;
     - fails open to `{}` once, with `fetchRetries: 0`;
     - malformed `time` is filtered;
     - **#104 regression:** `@corp/pkg` reaches the `@corp:registry` server at `/@corp%2fpkg` with `Bearer SCOPED`, the default server sees nothing, and `ms` reaches the default server with `Bearer DEFAULT`;
     - `clearRegistryCache()` in `afterEach`.
   - **New `__tests__/startup.test.ts`:**

     ```ts
     const mockClientLoaded = jest.fn()
     jest.mock('@/utils/registryClient', () => { mockClientLoaded(); return {} })
     jest.mock('@/utils/config')
     it('loads no registry client while the CLI loads', async () => {
       await import('@/cli'); expect(mockClientLoaded).not.toHaveBeenCalled()
     })
     ```

     Keep it separate from `cli.test.ts`, which mocks `@/utils/registry` wholesale and so can't prove `registry.ts` is light.
   - Optionally update the `loadRegistryConfig` mocks in `__tests__/utils/filterPackages.test.ts` and `__tests__/utils/releaseAges.test.ts` to the new shape. They're untyped and the registry is mocked.

**Gates:** as in Phase 1, plus a real run against `dist`:
- `node dist/index.js --version` must not load the client. Check with `node -r <scratch>/report.js dist/index.js --version`, where `report.js` prints `Object.keys(require.cache).filter(k => k.includes('registryClient'))` on `exit`.
- If hyperfine is available, `hyperfine 'node dist/index.js --version'` before and after; about 48 ms saved is expected.

## Phase 3: Node floor, CI on Node 22, docs

**Tasks**
1. `package.json`: `"engines": { "node": "^22.23.0 || >=24.17.0", ... }`. `.tool-versions` stays at 24.22.1.
2. Grep `src/` for APIs newer than Node 22: `RegExp.escape`, `Promise.try`, `Error.isError`, `Float16Array`, `Math.sumPrecise`, `Uint8Array.fromBase64`/`toBase64`, `agentKeepAliveTimeoutBuffer`.
3. `.github/workflows/ci.yml`, `test` job: add a `node` axis, reusing the existing SHA pins (no new actions).

   ```yaml
   name: ${{ matrix.node == 'tool-versions' && format('test ({0})', matrix.os) || format('test ({0}, Node {1})', matrix.os, matrix.node) }}
   strategy: { fail-fast: false, matrix: { os: [ubuntu-latest, windows-latest], node: [tool-versions, 22.23.x] } }
   # tools step also: echo "node=$(awk '$1 == "nodejs" { print $2 }' .tool-versions)" >> "$GITHUB_OUTPUT"
   - uses: actions/setup-node@<existing SHA> # <existing version>
     with:
       node-version: ${{ matrix.node == 'tool-versions' && steps.tools.outputs.node || matrix.node }}
       cache: pnpm
   # Biome and check-types: if runner.os == 'Linux' && matrix.node == 'tool-versions'
   - name: The built CLI starts
     run: |
       node dist/index.js --version
       node dist/index.js help
   ```

   - The smoke step matters. Unit tests run through swc, which transforms commander 15 and `@inquirer/prompts` (ESM); only the built CommonJS output proves `require(esm)` works on 22.23.
   - The integration job stays on `.tool-versions`.
4. Docs:
   - **`CLAUDE.md`:**
     - Engine Requirements becomes `^22.23.0 || >=24.17.0`, with the reason (`Agent` `proxyEnv` since 22.21 and 24.5; CVE-2026-48615 fixed in 22.23.0 and 24.17.0).
     - Replace the Configuration System bullets for `registry.ts` and `npmrcLoader.ts` with the parser, layering, client, lazy loading and `RegistryConfig`.
     - Testing Notes: CI runs the unit suite on 22.23.x and `.tool-versions`; local-server tests use the committed TLS fixtures (`generate.sh`).
   - **`src/utils/CLAUDE.md`:** the subsystem list (`npmrc.ts`, `registryRequest.ts`, `registryClient.ts`), a rewritten "Registry / .npmrc" section, and an Integration Points note that `npmrcLoader` uses `@/managers/workspaces`.
   - **`.claude/context/ai-context/docs-overview.md`:** the Tech Stack Node line, Key Dependencies without npm-registry-fetch and ini, the new test files and `fixtures/tls/`.
   - **`README.md`:**
     - Requirements: "Node.js 22.23 or later on 22, or 24.17 or later".
     - One sentence on the `cooldown` row or under Troubleshooting: cooldown reads `.npmrc` the way npm does (registries and scoped registries, per-registry auth, `ca`/`cafile`/`strict-ssl`, `https-proxy`/`proxy`/`noproxy`, `fetch-retries`, `fetch-timeout`, `maxsockets`).
     - SOCKS proxies are not supported.
     - A failed lookup lets the update through; `"debug": true` shows the request that failed.
5. Regenerate the coverage badges (`pnpm run test:badges`) and keep `badges/`.

**Gates:** as above. CI on Node 22 is verified on the PR. The integration matrix (`pnpm run test:integration`, network) is optional; nothing in it runs cooldown.

## Test coverage matrix (the Done-when checklist)

Each heading is a setting, with the test file in brackets; the bullets are what must be asserted.

**`ca` / `ca[]` / `cafile` / `strict-ssl`** (`registryClient.test.ts`, HTTPS server signed by the test CA)
- No `ca` → rejected, not retried.
- `ca` (a PEM string, and a double-quoted `"…\n…"` value) succeeds; `ca[]` succeeds.
- `cafile` relative to cwd and as `~/ca.pem` succeeds through a real `.npmrc` and `loadRegistryConfig`. `cafile` beats a wrong `ca`.
- `strict-ssl=false` succeeds with no CA.
- With no `ca` configured, the default store is used: `tls.setDefaultCACertificates([...tls.getCACertificates('default'), ca])`, restored after, guarded by `typeof tls.setDefaultCACertificates === 'function' ? it : it.skip`.

**`certfile` + `keyfile`** (`registryClient.test.ts`, mTLS server)
- With `//127.0.0.1:P/:certfile` and `:keyfile`, the server sees CN `autd test client`.
- Without them, rejected.

**`_authToken`, `_auth`, `username` + `_password`, longest prefix** (`registryClient.test.ts`, HTTP server recording `authorization`)
- `Bearer`; `Basic` unchanged; `Basic base64(user:decoded)`.
- Host and `/npm/repo/` tokens with registry `/npm/repo/` sends `REPO`.
- A token for another port isn't sent; an unscoped `_authToken` isn't sent.
- Redirects: same-host 302 is followed with credentials recomputed; a cross-port redirect drops the token; https→http is refused.

**Scoped registries (#104)** (`registry.test.ts`)
- The two-server case above.

**`https-proxy`, `proxy`, env** (`registryClient.test.ts`, CONNECT proxy)
- `https-proxy=http://u%40corp:p%3Ass@127.0.0.1:PP`: the proxy sees `CONNECT 127.0.0.1:SP` and Basic proxy auth.
- `proxy=` alone is used for HTTPS.
- Env `HTTPS_PROXY` is used when `.npmrc` sets none; `.npmrc` `https-proxy` beats env (two proxies, assert which one saw it).

**`noproxy`, `NO_PROXY`, suffix matching** (`registryClient.test.ts`)
- `noproxy=127.0.0.1` bypasses: the proxy sees nothing.
- Env `NO_PROXY` applies when `.npmrc` has none; `.npmrc` `noproxy` overrides it.
- Suffix: an HTTP registry `http://registry.example.test:P/` with the injected `lookup` → 127.0.0.1 and `proxy=http://127.0.0.1:PP`. `noproxy=example.test` goes direct; `noproxy=other.test` → the proxy sees `GET http://registry.example.test:P/...`.
- In `npmrcLoader.test.ts`: the widened `NO_PROXY` string, and `noproxy[]` arrays.

**`fetch-retries` + `Retry-After`** (`registryClient.test.ts`)
- 503, 503, 200 → succeeds, `delays = [100, 200]`.
- 429 with `Retry-After: 1` → `[1000]`; `Retry-After: 120` → one request, no delay.
- 404 → one request; `fetch-retries=0` → one request.
- A socket destroyed once (ECONNRESET) → retried.
- A closed port (ECONNREFUSED) → 3 attempts.

**`fetch-timeout`** (`registryClient.test.ts`)
- A server that never answers, `fetch-timeout=100`, `fetch-retries=1`: 2 requests, then `code: 'ETIMEDOUT'`.
- Headers then a stalled body also times out.

**`maxsockets`** (`registryClient.test.ts`)
- `maxsockets=1`, 3 concurrent `getJson`, 50 ms delayed handler: the server's peak in-flight count is 1.

**Keep-alive, one agent, gzip** (`registryClient.test.ts`)
- Two sequential requests → one `connection` event.
- A gzip body is decoded; `accept: application/json` and `accept-encoding: gzip` are sent.

**Layering reaches the wire** (`registryClient.test.ts`)
- A token in the global, user, project and env layers: the server sees the env one. Remove layers one at a time.

**Layering details** (`npmrcLoader.test.ts`)
- As listed in Phase 1.

**Parser** (`npmrc.test.ts`)
- The ini port plus env-replace.

**Lazy load** (`startup.test.ts`)
- As above.

## Design Considerations

- **Performance.**
  - Startup drops the 171-module client; `registryClient` loads only on the first cooldown request.
  - The parser and loader are small and synchronous.
  - Cooldown concurrency stays as today: `Promise.all`, with sockets bounded by `maxSockets` (excess queues in the agent). #47 adds bounded concurrency and caching.
  - Packuments are still buffered whole; #105 and #47 replace the full-packument read.
- **Security.**
  - Credentials go only to the prefixes `.npmrc` scopes them to; redirects recompute them.
  - No header values or URL userinfo appear in errors or debug logs.
  - The CVE-2026-48615 fix is guaranteed by the floor.
  - `strict-ssl` is passed explicitly, as npm does, so it overrides `NODE_TLS_REJECT_UNAUTHORIZED`.
- **Fail open.**
  - Every client error becomes `{}` and a debug line in `fetchReleaseTimes`.
  - Loader file errors are empty layers.
  - An unreadable `cafile`, `certfile` or `keyfile` fails that request open.

## Risks & Mitigation

1. **Node 22 toolchain in CI.** pnpm 12.14 and `tsc` 7 must run on 22.23.x, and the built CLI's `require(esm)` of commander 15 and `@inquirer/prompts` must work.
   - The new CI jobs and the smoke step prove it. If pnpm refuses Node 22, set `standalone: true` on `pnpm/action-setup`.
   - `@types/node` stays 26, so types allow APIs newer than the floor; the Phase 3 grep and the Node 22 jobs catch them.
2. **Test leakage from the developer's machine.** These are now read: `npm_config_*` in lower case, `HOME`, the global npmrc and `PREFIX`.
   - New tests inject `NpmrcSources`; existing adapter tests use `isolateNpmConfig`.
   - Client tests inject proxy settings through the config, never `process.env`. A stray `HTTPS_PROXY` must not route `127.0.0.1` tests.
3. **Windows.** JSON-quoted paths in test `.npmrc` files, `127.0.0.1` URLs, `closeAllConnections()`. Env-var names with `//` exist only in injected env objects.
4. **Committed private keys.** They are test-only, with no CA key. If GitHub push protection flags a PEM, they are fixtures by design; exclude them in the repo's secret-scanning settings rather than generating at test time.
5. **Node's built-in proxy is Stability 1.1.** The CONNECT and `noproxy` tests pin its behavior on 22 and 24. SOCKS is a documented gap.
6. **User-visible behavior changes** (list them in the PR):
   - An unset `${VAR}` stays literal.
   - The global npmrc and lower-case `npm_config_*` are read.
   - A workspace member uses the root's `.npmrc` (this affects npm and bun `saveStyle` too).
   - Unscoped `_authToken` and `always-auth` are ignored.
   - Not supported: `fetch-retry-factor`, `fetch-retry-mintimeout` and `fetch-retry-maxtimeout` (a short capped backoff instead), `DESTDIR`, and `prefix` from config.
7. **Retry-After over the 1 s cap stops retrying instead of waiting.** This keeps the budget and fails open. The constants are exported, so #47 can revisit them.
