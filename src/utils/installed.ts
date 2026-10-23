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

/**
 * The version installed for each of `names` that the root package.json
 * declares, read from `node_modules/<name>/package.json` (a symlink into the
 * store on pnpm). A root dependency always sits there, whatever the manager
 * hoisted or nested. Names declared only by a workspace member, and packages
 * with no node_modules entry (yarn berry's PnP), are left out: there is
 * nothing here to check them against.
 */
export const readInstalledVersions = (
  cwd: string,
  names: string[],
): Record<string, string> => {
  const manifest = readJson(path.join(cwd, 'package.json'))
  const declared = new Set(
    DEPENDENCY_FIELDS.flatMap((field) =>
      Object.keys((manifest?.[field] as Record<string, unknown>) ?? {}),
    ),
  )

  const installed: Record<string, string> = {}
  for (const name of names) {
    if (!declared.has(name)) continue
    const version = readJson(
      path.join(cwd, 'node_modules', name, 'package.json'),
    )?.version
    if (typeof version === 'string') installed[name] = version
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
    const version = installed[result.name]
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
