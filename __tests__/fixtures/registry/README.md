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
