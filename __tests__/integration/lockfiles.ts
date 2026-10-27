/**
 * Lockfile rewriters for the integration harness. The harness installs every
 * range at its minimum version, restores the ranges in the manifests, and then
 * edits the lockfile so it records the restored ranges against the installed
 * versions, which is what a real project looks like some weeks after its last
 * install. All functions are pure and keep the file's line endings. A rewrite
 * the file has no place for throws: a silent miss would leave the lockfile
 * disagreeing with the manifest and the matrix would fail somewhere far away.
 */

import {
  manifestEntries,
  type RangedDependency,
  splitLines,
} from '@/managers/yarn/lockfile'

export {
  escapeRegExp,
  type RangedDependency,
  rewriteBerryLock,
  rewriteYarnV1Lock,
} from '@/managers/yarn/lockfile'

const BUN_DEPENDENCY_FIELDS =
  /^ {6}"(dependencies|devDependencies|optionalDependencies)": \{$/

/**
 * bun.lock: inside `"workspaces"` -> `"<path>"` (root `""`) the specifier
 * `"name": "<installed>"` becomes `"name": "<range>"`, and so do the entries of
 * the top-level `"catalog"` and `"catalogs"` objects. bun.lock is JSONC with a
 * fixed two-space layout, so the objects are found by indentation.
 */
export const rewriteBunLock = (
  lock: string,
  ranged: RangedDependency[],
): string => {
  const { lines, eol } = splitLines(lock)
  const done = new Set<RangedDependency>()
  let top: string | undefined
  let workspacePath: string | undefined
  let group: string | undefined
  let inDependencies = false

  const rewrite = (
    line: string,
    indent: string,
    match: (dep: RangedDependency) => boolean,
  ): string => {
    const entry = /^( +)"([^"]+)": "([^"]*)"(,?)$/.exec(line)
    if (!entry || entry[1] !== indent) return line
    const dep = ranged.find(
      (candidate) =>
        candidate.name === entry[2] &&
        candidate.installed === entry[3] &&
        match(candidate),
    )
    if (!dep) return line
    done.add(dep)
    return `${entry[1]}"${entry[2]}": "${dep.range}"${entry[4]}`
  }

  const out = lines.map((line) => {
    const topKey = /^ {2}"([^"]+)": [{[]/.exec(line)
    if (topKey) {
      top = topKey[1]
      group = undefined
      return line
    }
    if (top === 'workspaces') {
      const ws = /^ {4}"([^"]*)": \{$/.exec(line)
      if (ws) {
        workspacePath = ws[1] === '' ? '.' : ws[1]
        inDependencies = false
        return line
      }
      if (BUN_DEPENDENCY_FIELDS.test(line)) inDependencies = true
      else if (/^ {6}\},?$/.test(line)) inDependencies = false
      return inDependencies
        ? rewrite(line, ' '.repeat(8), (dep) => dep.workspace === workspacePath)
        : line
    }
    if (top === 'catalog') {
      return rewrite(line, ' '.repeat(4), (dep) => dep.catalog === 'default')
    }
    if (top === 'catalogs') {
      const named = /^ {4}"([^"]+)": \{$/.exec(line)
      if (named) {
        group = named[1]
        return line
      }
      return rewrite(line, ' '.repeat(6), (dep) => dep.catalog === group)
    }
    return line
  })

  for (const dep of ranged) {
    if (!done.has(dep)) {
      const where =
        dep.catalog === undefined
          ? `workspace ${dep.workspace}`
          : `catalog ${dep.catalog}`
      throw new Error(
        `bun.lock: no ${dep.name}@${dep.installed} specifier in ${where}`,
      )
    }
  }
  return out.join(eol)
}

const NPM_DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const

/**
 * package-lock.json: `packages[<path>].<field>[name]` goes from the installed
 * version to the range, where `<path>` is "" for the root and the member's
 * path otherwise. JSON in, JSON out with npm's two-space indent and trailing
 * newline.
 */
export const rewriteNpmLock = (
  lock: string,
  ranged: RangedDependency[],
): string => {
  const eol = lock.includes('\r\n') ? '\r\n' : '\n'
  const parsed = JSON.parse(lock) as {
    packages?: Record<string, Record<string, Record<string, string>>>
  }

  for (const dep of manifestEntries(ranged)) {
    const key = dep.workspace === '.' ? '' : dep.workspace
    const entry = key === undefined ? undefined : parsed.packages?.[key]
    const field = NPM_DEPENDENCY_FIELDS.find(
      (candidate) => entry?.[candidate]?.[dep.name] === dep.installed,
    )
    if (!entry || !field) {
      throw new Error(
        `package-lock.json: no ${dep.name}@${dep.installed} in packages["${key ?? ''}"]`,
      )
    }
    entry[field][dep.name] = dep.range
  }

  const text = JSON.stringify(parsed, null, 2)
  return `${eol === '\n' ? text : text.replaceAll('\n', eol)}${/\n$/.test(lock) ? eol : ''}`
}

const unquoteYaml = (text: string): string =>
  text.replace(/^(['"])(.*)\1$/, '$2')

/**
 * pnpm-lock.yaml: under `importers:` -> `<path>:` (`.` for the root) the
 * dependency's `specifier:` line goes from the installed version to the range;
 * a catalog entry's `specifier:` under `catalogs:` -> `<catalog>` (`default`
 * for the default one) -> `<name>:` does the same.
 */
export const rewritePnpmLock = (
  lock: string,
  ranged: RangedDependency[],
): string => {
  const { lines, eol } = splitLines(lock)
  const done = new Set<RangedDependency>()
  let top: string | undefined
  let group: string | undefined
  let name: string | undefined

  const out = lines.map((line) => {
    const topKey = /^([^\s#][^:]*):/.exec(line)
    if (topKey) {
      top = topKey[1]
      group = undefined
      name = undefined
      return line
    }
    if (top !== 'importers' && top !== 'catalogs') return line

    const groupKey = /^ {2}(\S.*):$/.exec(line)
    if (groupKey) {
      group = unquoteYaml(groupKey[1])
      name = undefined
      return line
    }
    const nameKey = top === 'catalogs' ? /^ {4}(\S.*):$/ : /^ {6}(\S.*):$/
    const named = nameKey.exec(line)
    if (named) {
      name = unquoteYaml(named[1])
      return line
    }

    const specifierIndent = top === 'catalogs' ? 6 : 8
    const specifier = new RegExp(
      `^( {${specifierIndent}}specifier: )(\\S.*)$`,
    ).exec(line)
    if (!specifier || name === undefined) return line

    const dep = ranged.find(
      (candidate) =>
        candidate.name === name &&
        candidate.installed === unquoteYaml(specifier[2]) &&
        (top === 'catalogs'
          ? candidate.catalog === group
          : candidate.catalog === undefined && candidate.workspace === group),
    )
    if (!dep) return line
    done.add(dep)
    return `${specifier[1]}${dep.range}`
  })

  for (const dep of ranged) {
    if (!done.has(dep)) {
      const where =
        dep.catalog === undefined
          ? `importer ${dep.workspace}`
          : `catalog ${dep.catalog}`
      throw new Error(
        `pnpm-lock.yaml: no ${dep.name} specifier ${dep.installed} in ${where}`,
      )
    }
  }
  return out.join(eol)
}
