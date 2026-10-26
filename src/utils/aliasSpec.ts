// The one definition of an `npm:` alias, shared by the readers
// (dependencySpecs, berry) and the writers (nextVersionSpec), so they agree
// on what an alias is. Imports nothing.

const TARGET = '((?:@[^/@]+\\/)?[^@]+)'
const ALIAS = new RegExp(`^npm:${TARGET}@(.+)$`)
const BARE_ALIAS = new RegExp(`^npm:${TARGET}$`)

/** `npm:<target>@<range>` as its target and range, else undefined. */
export const parseAlias = (
  spec: string,
): { name: string; range: string } | undefined => {
  const match = ALIAS.exec(spec)
  return match ? { name: match[1], range: match[2] } : undefined
}

/**
 * The target of `npm:<target>` with no range, else undefined. npm reads it
 * as `npm:<target>@latest` (verified on npm 11.19.1: `"l": "npm:ms"` installs
 * ms 2.1.3 as node_modules/l).
 */
export const parseBareAlias = (spec: string): string | undefined =>
  BARE_ALIAS.exec(spec)?.[1]
