import fs from 'fs'
import path from 'path'
import semver from 'semver'
import type { UpdateResult } from '@/types'
import { DEPENDENCY_FIELDS } from './manifestNames'

const readJson = (file: string): Record<string, unknown> | undefined => {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return undefined
  }
}

/** The key a row's installed version is stored under: its name, plus the manifest in a workspace project. */
export const rowKey = ({
  name,
  workspace,
}: {
  name: string
  workspace?: string
}): string => (workspace === undefined ? name : `${workspace}:${name}`)

/**
 * The version installed for each row whose manifest declares it, read from
 * `node_modules/<name>/package.json` (a symlink into the store on pnpm).
 * A workspace member's own `node_modules` is read first, since the manager
 * may nest a copy there; the root's holds the hoisted one. In a
 * single-package project that is the root's only. Names a manifest does not
 * declare, and packages with no node_modules entry (yarn berry's PnP), are
 * left out: there is nothing here to check them against.
 */
export const readInstalledVersions = (
  cwd: string,
  rows: { name: string; workspace?: string }[],
): Record<string, string> => {
  const declaredBy = new Map<string, Set<string>>()
  const declaredIn = (dir: string): Set<string> => {
    let declared = declaredBy.get(dir)
    if (!declared) {
      const manifest = readJson(path.join(dir, 'package.json'))
      declared = new Set(
        DEPENDENCY_FIELDS.flatMap((field) =>
          Object.keys((manifest?.[field] as Record<string, unknown>) ?? {}),
        ),
      )
      declaredBy.set(dir, declared)
    }
    return declared
  }

  const installed: Record<string, string> = {}
  for (const row of rows) {
    const dir = path.join(cwd, row.workspace ?? '.')
    if (!declaredIn(dir).has(row.name)) continue
    const lookups = dir === cwd ? [cwd] : [dir, cwd]
    for (const base of lookups) {
      const version = readJson(
        path.join(base, 'node_modules', row.name, 'package.json'),
      )?.version
      if (typeof version === 'string') {
        installed[rowKey(row)] = version
        break
      }
    }
  }
  return installed
}

/**
 * Checks each moving row against what the manager installed. The manager
 * owns apply and can leave a package in place while exiting 0 (`npm update
 * ms` keeps a hoisted ms that another dependency pins exactly), so a row
 * whose installed version is below its target is no longer `updated`, and
 * its reason says what is installed. A row with no installed version to
 * check keeps what the plan said.
 */
export const checkApplied = (
  results: UpdateResult[],
  installed: Record<string, string>,
  manager: string,
): UpdateResult[] =>
  results.map((result) => {
    const version = installed[rowKey(result)]
    if (!result.updated || !result.target || version === undefined) {
      return result
    }
    if (!semver.valid(version) || semver.gte(version, result.target)) {
      return result
    }
    return {
      ...result,
      target: undefined,
      updated: false,
      reason: `not applied by ${manager} (installed ${version})`,
    }
  })
