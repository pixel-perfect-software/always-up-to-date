# Registry fixtures

Verbatim decoded response bodies, captured with curl on 2026-10-26 (`curl --compressed`, no credentials, no `.npmrc`). Never hand-edit one: a test that needs a variant derives it from a captured body (`derive` in the test). Headers are not kept; the table records what matters. The `.body` extension keeps Biome off the bytes.

Wire size is the compressed size on the wire. The capture machine runs an Aikido TLS proxy that intercepts registry.npmjs.org and can strip very fresh versions from packuments, so each package was checked before it was committed:

- deps.dev and the abbreviated packument list the same versions and the same deprecated versions, and both include the dist-tags `latest`;
- no package has had a release for months (the newest version of `ms` is from 2025-08, of `@types/ms` from 2025-01, of `mkdirp` from 2023-04);
- `mkdirp` has 25 deprecated versions of 42, and a `latest` (3.0.1) that is not deprecated;
- `autd-no-such-package-20261026` is a 404 on registry.npmjs.org too;
- `https://registry.yarnpkg.com/-/package/ms/dist-tags` returns a body byte-identical to `ms.dist-tags.body`.

| File | Request | Status | Content type | Wire size |
|---|---|---|---|---|
| `ms.dist-tags.body` | `registry.npmjs.org/-/package/ms/dist-tags` | 200 | `application/json` | 109 B |
| `types-ms.dist-tags.body` | `registry.npmjs.org/-/package/@types%2fms/dist-tags` | 200 | `application/json` | 166 B |
| `mkdirp.dist-tags.body` | `registry.npmjs.org/-/package/mkdirp/dist-tags` | 200 | `application/json` | 35 B |
| `ms.deps-dev.body` | `api.deps.dev/v3/systems/npm/packages/ms` | 200 | `application/json; charset=utf-8` | 589 B |
| `types-ms.deps-dev.body` | `api.deps.dev/v3/systems/npm/packages/%40types%2Fms` | 200 | `application/json; charset=utf-8` | 398 B |
| `mkdirp.deps-dev.body` | `api.deps.dev/v3/systems/npm/packages/mkdirp` | 200 | `application/json; charset=utf-8` | 867 B |
| `ms.packument.body` | `registry.npmjs.org/ms`, abbreviated `Accept` | 200 | `application/vnd.npm.install-v1+json` | 11206 B |
| `types-ms.packument.body` | `registry.npmjs.org/@types%2fms`, abbreviated `Accept` | 200 | `application/vnd.npm.install-v1+json` | 4299 B |
| `mkdirp.packument.body` | `registry.npmjs.org/mkdirp`, abbreviated `Accept` | 200 | `application/vnd.npm.install-v1+json` | 20272 B |
| `types-ms.packument-full.body` | `registry.npmjs.org/@types%2fms`, `Accept: application/json` | 200 | `application/json` | 6313 B |
| `not-found.deps-dev.body` | `api.deps.dev/v3/systems/npm/packages/autd-no-such-package-20261026` | 404 | `text/plain; charset=utf-8` | 42 B |

## Discovery captures (2026-10-26)

Captured for #106's `wanted` rule, spec and catalog tests; the same checks ran first (curl `--compressed`, no credentials, the Aikido proxy in the path):

- deps.dev and the abbreviated packument list the same versions and the same deprecated versions for 12 of the 14 packages, and both include `latest`. The packuments of every package but `yarn` and `pnpm` were fetched into a scratchpad and are not committed.
- `react` and `react-dom` failed that check, and the packument was at fault. deps.dev lists `0.0.0-experimental-fd51cb10-20261026` (2991 and 2946 versions), published that day, and the proxied packument omits it (2990 and 2945). The registry's own dist-tags endpoint names that version as `experimental`, so deps.dev's list is the faithful one: the proxy strips fresh versions from packuments, as noted above. Their dist-tags and deps.dev bodies are committed; the packuments are not. Both deps.dev bodies include the dist-tags `latest` (19.3.1).
- `yarn`: `latest` is `1.22.22` and `berry` is `2.4.3`; 2.4.3 is listed and not deprecated.
- `pnpm`: 5.18.0 to 5.18.10 are not deprecated and 5.18.11 is.
- `dayjs`: 1.10.8 is the highest 1.10.x and is not deprecated.
- `pnpm.packument.body.gz` is 641517 B gzipped, under the 1 MB limit, so both sources are kept for `pnpm`.

A body over 100 KB decoded is committed as `<name>.body.gz` (`gzip -9 -n`); gunzipped it is the captured bytes. `*.gz` is `binary` in `.gitattributes`. Wire size is what curl downloaded; decoded size is the size of the body a test reads.

| File | Request | Status | Content type | Wire size | Decoded size | gz |
|---|---|---|---|---|---|---|
| `yarn.dist-tags.body` | `registry.npmjs.org/-/package/yarn/dist-tags` | 200 | `application/json` | 79 B | 68 B | no |
| `yarn.deps-dev.body` | `api.deps.dev/v3/systems/npm/packages/yarn` | 200 | `application/json; charset=utf-8` | 1854 B | 28036 B | no |
| `pnpm.dist-tags.body` | `registry.npmjs.org/-/package/pnpm/dist-tags` | 200 | `application/json` | 192 B | 452 B | no |
| `pnpm.deps-dev.body.gz` | `api.deps.dev/v3/systems/npm/packages/pnpm` | 200 | `application/json; charset=utf-8` | 16877 B | 236694 B | yes |
| `dayjs.dist-tags.body` | `registry.npmjs.org/-/package/dayjs/dist-tags` | 200 | `application/json` | 44 B | 44 B | no |
| `dayjs.deps-dev.body` | `api.deps.dev/v3/systems/npm/packages/dayjs` | 200 | `application/json; charset=utf-8` | 1966 B | 22623 B | no |
| `debug.dist-tags.body` | `registry.npmjs.org/-/package/debug/dist-tags` | 200 | `application/json` | 33 B | 33 B | no |
| `debug.deps-dev.body` | `api.deps.dev/v3/systems/npm/packages/debug` | 200 | `application/json; charset=utf-8` | 1446 B | 15492 B | no |
| `express.dist-tags.body` | `registry.npmjs.org/-/package/express/dist-tags` | 200 | `application/json` | 38 B | 38 B | no |
| `express.deps-dev.body` | `api.deps.dev/v3/systems/npm/packages/express` | 200 | `application/json; charset=utf-8` | 3606 B | 56708 B | no |
| `semver.dist-tags.body` | `registry.npmjs.org/-/package/semver/dist-tags` | 200 | `application/json` | 71 B | 54 B | no |
| `semver.deps-dev.body` | `api.deps.dev/v3/systems/npm/packages/semver` | 200 | `application/json; charset=utf-8` | 1616 B | 19593 B | no |
| `zod.dist-tags.body` | `registry.npmjs.org/-/package/zod/dist-tags` | 200 | `application/json` | 131 B | 145 B | no |
| `zod.deps-dev.body.gz` | `api.deps.dev/v3/systems/npm/packages/zod` | 200 | `application/json; charset=utf-8` | 11766 B | 177671 B | yes |
| `axios.dist-tags.body` | `registry.npmjs.org/-/package/axios/dist-tags` | 200 | `application/json` | 89 B | 79 B | no |
| `axios.deps-dev.body` | `api.deps.dev/v3/systems/npm/packages/axios` | 200 | `application/json; charset=utf-8` | 2357 B | 29190 B | no |
| `lodash.dist-tags.body` | `registry.npmjs.org/-/package/lodash/dist-tags` | 200 | `application/json` | 19 B | 19 B | no |
| `lodash.deps-dev.body` | `api.deps.dev/v3/systems/npm/packages/lodash` | 200 | `application/json; charset=utf-8` | 1598 B | 19369 B | no |
| `next.dist-tags.body` | `registry.npmjs.org/-/package/next/dist-tags` | 200 | `application/json` | 193 B | 353 B | no |
| `next.deps-dev.body.gz` | `api.deps.dev/v3/systems/npm/packages/next` | 200 | `application/json; charset=utf-8` | 43531 B | 708283 B | yes |
| `qs.dist-tags.body` | `registry.npmjs.org/-/package/qs/dist-tags` | 200 | `application/json` | 144 B | 357 B | no |
| `qs.deps-dev.body` | `api.deps.dev/v3/systems/npm/packages/qs` | 200 | `application/json; charset=utf-8` | 2225 B | 26929 B | no |
| `typescript.dist-tags.body` | `registry.npmjs.org/-/package/typescript/dist-tags` | 200 | `application/json` | 150 B | 179 B | no |
| `typescript.deps-dev.body.gz` | `api.deps.dev/v3/systems/npm/packages/typescript` | 200 | `application/json; charset=utf-8` | 37603 B | 697559 B | yes |
| `react.dist-tags.body` | `registry.npmjs.org/-/package/react/dist-tags` | 200 | `application/json` | not recorded (chunked) | 238 B | no |
| `react.deps-dev.body.gz` | `api.deps.dev/v3/systems/npm/packages/react` | 200 | `application/json; charset=utf-8` | 50011 B | 563799 B | yes |
| `react-dom.dist-tags.body` | `registry.npmjs.org/-/package/react-dom/dist-tags` | 200 | `application/json` | not recorded (chunked) | 238 B | no |
| `react-dom.deps-dev.body.gz` | `api.deps.dev/v3/systems/npm/packages/react-dom` | 200 | `application/json; charset=utf-8` | 49807 B | 569528 B | yes |
| `yarn.packument.body.gz` | `registry.npmjs.org/yarn`, abbreviated `Accept` | 200 | `application/vnd.npm.install-v1+json` | 49698 B | 205172 B | yes |
| `pnpm.packument.body.gz` | `registry.npmjs.org/pnpm`, abbreviated `Accept` | 200 | `application/vnd.npm.install-v1+json` | 646327 B | 1910352 B | yes |

## Cache headers (2026-10-27)

Captured for #108 with `curl --compressed -D`, no credentials, no `.npmrc`, `Accept: application/json` (dist-tags, full packument, deps.dev) or the abbreviated `Accept` (packument). Header files are not kept. The Aikido TLS proxy sits in front of registry.npmjs.org on this machine and may rewrite headers; registry.npmjs.org answered through Cloudflare (`cf-cache-status: DYNAMIC` on dist-tags), and the values below are what reached curl. `ms`, `next` and `@types/ms` gave the same headers per endpoint apart from `ETag`, `Age` and `Last-Modified`.

| Endpoint | `Cache-Control` | `ETag` | `Age` | `Vary` | `If-None-Match` |
|---|---|---|---|---|---|
| registry.npmjs.org `/-/package/<name>/dist-tags` | none | none | none | `accept-encoding` | no ETag to send; a made-up one gets 200 |
| registry.yarnpkg.com `/-/package/ms/dist-tags` | none | none | none | `accept-encoding` | no ETag to send |
| registry.npmjs.org `/<name>`, abbreviated | `public, max-age=300` | weak, `W/"<32 hex>"` | 42 to 132 s | `accept-encoding, accept` | the ETag of `ms` gets 304 |
| registry.npmjs.org `/<name>`, `application/json` | `public, max-age=300` | weak, `W/"<32 hex>"` (differs from the abbreviated one) | 15 to 118 s | `accept-encoding, accept` | not tried |
| api.deps.dev `/v3/systems/npm/packages/<name>` | `public, max-age=3600` | none | none | `Accept-Encoding` | no ETag to send |

The dist-tags answers carry only a `__cf_bm` cookie, no validator and no freshness header, so a cache of them is TTL-only. Packuments carry both, and a conditional request is answered with 304.
