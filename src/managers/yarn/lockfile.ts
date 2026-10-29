/**
 * yarn.lock rewriters: record a manifest's range against a version already
 * locked under another spec. The integration harness uses them to make a
 * lockfile agree with restored ranges; apply uses them after pinning a
 * cooldown fallback and restoring its range (#147), since yarn resolves a
 * spec it has no key for again, to the newest version. A rewrite the file has
 * no place for throws: a silent miss would leave the lockfile disagreeing
 * with the manifest.
 */

import { parseAlias } from '@/utils/aliasSpec'

/** A spec whose range should resolve to a version locked under another spec. */
export interface RangedDependency {
  /** The manifest's directory relative to the root, POSIX separators ('.' = root). */
  workspace?: string
  /** A catalog entry instead of a manifest dependency: 'default' or the catalog's name. */
  catalog?: string
  name: string
  /** The range as written in the repo, e.g. `^4.0.0`, or an alias's `npm:ms@^2.0.0`. */
  range: string
  /** The version locked under another spec (the harness: `semver.minVersion(range)`). */
  installed: string
}

export const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const splitLines = (text: string): { lines: string[]; eol: string } => ({
  lines: text.split(/\r?\n/),
  eol: text.includes('\r\n') ? '\r\n' : '\n',
})

export const manifestEntries = (
  ranged: RangedDependency[],
): RangedDependency[] => ranged.filter((dep) => dep.catalog === undefined)

const unquote = (text: string): string => text.replace(/^"(.*)"$/, '$1')

/**
 * The spec the installed version is locked under: the version, or for an
 * alias its target and the version (`npm:ms@2.1.2`), which yarn 1.22.22 and
 * 4.12.0 both write as `m@npm:ms@2.1.2` (#152).
 */
const lockedSpec = ({ range, installed }: RangedDependency): string => {
  const alias = parseAlias(range)
  return alias ? `npm:${alias.name}@${installed}` : installed
}

/** A spec as berry's lockfile writes it: `npm:` before a range; an alias already has it. */
const berrySpec = (spec: string): string =>
  spec.startsWith('npm:') ? spec : `npm:${spec}`

/**
 * A yarn v1 key as yarn 1.22.22 writes it (`shouldWrapKey` and `maybeWrap`
 * in its lockfile stringifier): JSON-quoted when it starts with `true`,
 * `false` or anything but a letter, or holds whitespace, `:`, `\`, `"`, `,`,
 * `[` or `]`. A bare `ms@^1 || ^3` reads back as another pattern, so yarn
 * resolves the range again (#151).
 */
const quoteV1Key = (key: string): string =>
  /^(true|false)/.test(key) ||
  /[:\s\\",[\]]/.test(key) ||
  !/^[a-zA-Z]/.test(key)
    ? JSON.stringify(key)
    : key

/**
 * yarn v1: the key line that lists `name@<installed>` gains `name@<range>`:
 * `chalk@4.0.0:` becomes `chalk@4.0.0, chalk@^4.0.0:`.
 */
export const rewriteYarnV1Lock = (
  lock: string,
  ranged: RangedDependency[],
): string => {
  const { lines, eol } = splitLines(lock)
  const wanted = manifestEntries(ranged)
  const done = new Set<RangedDependency>()

  const out = lines.map((line) => {
    const match = /^(\S.*):$/.exec(line)
    if (!match || line.startsWith('#')) return line

    const keys = match[1].split(', ').map(unquote)
    const added: string[] = []
    for (const dep of wanted) {
      if (!keys.includes(`${dep.name}@${lockedSpec(dep)}`)) continue
      done.add(dep)
      const key = `${dep.name}@${dep.range}`
      if (!keys.includes(key) && !added.includes(key)) added.push(key)
    }
    if (added.length === 0) return line

    return `${[...keys, ...added].sort().map(quoteV1Key).join(', ')}:`
  })

  for (const dep of wanted) {
    if (!done.has(dep)) {
      throw new Error(`yarn.lock: no key for ${dep.name}@${lockedSpec(dep)}`)
    }
  }
  return out.join(eol)
}

/**
 * yarn berry: `"name@npm:<installed>":` gains `name@npm:<range>`, and inside
 * each `"<name>@workspace:<path>":` entry the dependency `name: "npm:<installed>"`
 * becomes `name: "npm:<range>"`.
 */
export const rewriteBerryLock = (
  lock: string,
  ranged: RangedDependency[],
): string => {
  const { lines, eol } = splitLines(lock)
  const wanted = manifestEntries(ranged)
  const keyDone = new Set<string>()
  const specDone = new Set<RangedDependency>()
  let workspace: string | undefined

  const out = lines.map((line) => {
    if (line === '') {
      workspace = undefined
      return line
    }
    const key = /^"(.*)":$/.exec(line)
    if (key) {
      workspace = /@workspace:(.*)$/.exec(key[1])?.[1]
      if (workspace !== undefined) return line

      const items = key[1].split(', ')
      const added: string[] = []
      for (const dep of wanted) {
        if (!items.includes(`${dep.name}@${berrySpec(lockedSpec(dep))}`)) {
          continue
        }
        keyDone.add(`${dep.name}@${dep.installed}`)
        const item = `${dep.name}@${berrySpec(dep.range)}`
        if (!items.includes(item) && !added.includes(item)) added.push(item)
      }
      return added.length === 0
        ? line
        : `"${[...items, ...added].sort().join(', ')}":`
    }

    if (workspace === undefined) return line
    for (const dep of wanted) {
      if (dep.workspace !== workspace) continue
      const spec = new RegExp(
        `^(\\s+"?${escapeRegExp(dep.name)}"?: )"${escapeRegExp(berrySpec(lockedSpec(dep)))}"$`,
      ).exec(line)
      if (!spec) continue
      specDone.add(dep)
      return `${spec[1]}"${berrySpec(dep.range)}"`
    }
    return line
  })

  for (const dep of wanted) {
    if (!keyDone.has(`${dep.name}@${dep.installed}`)) {
      throw new Error(
        `yarn.lock: no key for ${dep.name}@${berrySpec(lockedSpec(dep))}`,
      )
    }
    if (!specDone.has(dep)) {
      throw new Error(
        `yarn.lock: no ${dep.name} dependency in the workspace entry for ${dep.workspace}`,
      )
    }
  }
  return out.join(eol)
}
