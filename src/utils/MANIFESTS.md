# Manifest specs, catalogs and save style

Reference for `src/utils/versionSpecs.ts`, `manifests.ts`, `catalogs.ts` and `saveStyle.ts`. `src/utils/CLAUDE.md` links it; nothing imports it. Read it before changing how autd writes a spec, a manifest or a catalog entry.

## Files

```
versionSpecs.ts  # Spec shapes (#230): nextVersionSpec(currentSpec, version, style), isWorkspaceReference(), buildUpdateDescriptors() (yarn's `name@spec`)
manifests.ts     # Manifest writing (#230): formatLike(), updatePackageJson(), readSpec(), splitCatalogUpdates() (a beyond-range plan routed to catalogs and owning manifests)
catalogs.ts      # pnpm and bun catalogs (#230): updatePNPMWorkspaceYAML() (on the line-preserving catalog walk, which only the writer uses), readPnpmCatalogs(yaml) (`pnpmCatalogs(parsePnpmYaml(yaml))`, #229), readBunCatalogs(manifest) (reads `workspaces.catalog(s)` too), updateBunCatalogs()
saveStyle.ts     # SaveStyle (`pin`: write the bare version, #147), DEFAULT_SAVE_STYLE, readTextFile(), yamlValue() (a top-level `key: value` by regex; berry's `defaultSemverRangePrefix` is its one reader now, pnpm's settings go through `parsePnpmYaml`, #229): what adapters' saveStyle() builds on
```

## Rules

- Every writer builds the new spec with `nextVersionSpec()`: a single comparator (`^1.2.3`, `~1.2.3`, `1.2.3`) keeps its decorator, so an exact pin stays exact; an `npm:` alias keeps the alias and rewrites the spec inside it; a spec that can't keep its shape (`1.x`, `*`, `>=1 <2`, `^1 || ^2`) is written in the project's save style; git, file and URL specs are left alone
- Each adapter's `saveStyle(cwd)` reads that style where its manager's current version keeps it: npm `.npmrc` `save-exact` / `save-prefix`; pnpm `pnpm-workspace.yaml` `saveExact` / `savePrefix` (not `.npmrc`); yarn berry `.yarnrc.yml` `defaultSemverRangePrefix` (`''` = exact); bun `bunfig.toml` `[install] exact` or `.npmrc` `save-exact` (no prefix setting). Default `^`. Managers read it only when they write a beyond-range spec
- `catalog:` and `workspace:` references are never rewritten, and neither is a `peerDependencies` range: `updatePackageJson` writes `dependencies`, `optionalDependencies` and `devDependencies` only, as the managers' own update commands do (#155)
- JSON manifests are written back in their own format (`formatLike`): the detected indentation (tabs or N spaces), CRLF or LF, and a final newline only if the file had one, so a bump changes one line
- `updatePNPMWorkspaceYAML(cwd, versions, style, catalog?)` rewrites only entries under `catalog:` and under each named catalog in `catalogs:`; every other block (`overrides`, `peerDependencyRules`, settings) stays byte-for-byte. With `catalog` (`default` for `catalog:`) only that catalog moves, so `catalog:react18` never rewrites `react19`'s entry; the adapters call it once per catalog from `splitCatalogUpdates()`, which returns `catalogs` (catalog → name → version). An entry's value is read whole (`>=18.0.0 <19`, `"^17 || ^18"`, up to a trailing ` #` comment) and replaced whole; it keeps its quotes and its comment. It writes every entry `parsePnpmYaml` reads (#230): a flat one-line flow map (`catalog: { ms: ^2.1.1 }`, `  tools: &t { … }` under `catalogs:`) is rewritten item by item, every other byte kept, and a byte order mark is kept and stepped over; a nested flow map, which the reader leaves out, is left alone. `__tests__/utils/pnpmCatalogWriter.test.ts` keeps the two agreeing
- Bun reads `workspaces.catalog` / `workspaces.catalogs` as well as the top-level fields; when the `workspaces` one is set it replaces the top-level one as a whole, per field (verified on bun 1.4.4). `readBunCatalogs` and `updateBunCatalogs(cwd, versions, style, catalog?)` follow that
- `buildUpdateDescriptors()` applies the same rule to produce `name@spec` for managers that write the manifest themselves (yarn), reading `dependencies`, then `devDependencies`, then `optionalDependencies`
