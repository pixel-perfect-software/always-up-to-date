import fs from 'fs'
import path from 'path'

import type { SuccessCheck } from '@/commandRunner'
import type { ManagerAdapter } from '@/managers/adapter'
import {
  hasWorkspacesField,
  readManifest,
  readWorkspaceManifests,
  workspacePatterns,
} from '@/managers/workspaces'
import { StepError } from '@/stepError'
import type { OutdatedEntry, PackageInfo } from '@/types'
import { updatePackageJson } from '@/utils/files'
import { loadNpmrc, npmrcBoolean } from '@/utils/npmrcLoader'
import { manifestOverrides } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE } from '@/utils/saveStyle'

/**
 * `npm outdated` exits 1 whenever something is outdated. It also exits 1 on
 * real errors, printing `{ "error": { code, summary } }` instead of a report.
 */
const isOutdatedReport: SuccessCheck = ({ exitCode, stdout }) => {
  if (exitCode === 0) return true
  if (exitCode !== 1) return false
  try {
    const report = JSON.parse(stdout)
    const isNpmError =
      typeof report?.error?.code === 'string' &&
      typeof report?.error?.summary === 'string'
    return typeof report === 'object' && report !== null && !isNpmError
  } catch {
    return false
  }
}

/**
 * Versions package-lock.json records, keyed by install path
 * (`node_modules/ms`). Empty when there is no readable lockfile.
 */
export const readLockedVersions = (cwd: string): Record<string, string> => {
  let packages: Record<string, { version?: unknown }>
  try {
    packages =
      JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'))
        .packages ?? {}
  } catch {
    return {}
  }
  const versions: Record<string, string> = {}
  for (const [location, entry] of Object.entries(packages)) {
    if (typeof entry?.version === 'string') versions[location] = entry.version
  }
  return versions
}

/**
 * `npm outdated --json`: already keyed by name, with `wanted` filled. npm
 * reads `current` from node_modules, so a package that isn't installed (a
 * fresh clone) comes back without one. It takes the version the lockfile
 * records, which is what the other managers report there, or `missing`, as
 * npm's own table prints it, when the lockfile doesn't have it either.
 */
export const parseNpmOutdated = (
  stdout: string,
  locked: Record<string, string> = {},
): Record<string, PackageInfo> => {
  const report: Record<string, PackageInfo> = JSON.parse(stdout || '{}')
  for (const [key, info] of Object.entries(report)) {
    if (info.current) continue
    // An npm: alias is keyed `dj:dayjs@1.11.9` and installed as node_modules/dj.
    const name = key.split(':')[0]
    info.current = locked[`node_modules/${name}`] ?? 'missing'
  }
  return report
}

/**
 * `npm outdated --json --long` in a workspace project: a name maps to one
 * row, or an array of rows when several manifests declare it. Each row's
 * `dependedByLocation` is the owning manifest's directory relative to the
 * root, `''` for the root. A package that isn't installed has no `current`;
 * it falls back to the lockfile's record for that manifest, then the root's
 * hoisted copy, then `missing`.
 */
export const parseNpmWorkspaceOutdated = (
  stdout: string,
  locked: Record<string, string> = {},
): OutdatedEntry[] => {
  const report: Record<string, unknown> = JSON.parse(stdout || '{}')
  const entries: OutdatedEntry[] = []
  for (const [name, value] of Object.entries(report)) {
    for (const row of [value].flat() as Record<string, unknown>[]) {
      if (typeof row?.dependedByLocation !== 'string') {
        throw new StepError(
          'discover',
          `npm outdated --long reported no dependedByLocation for ${name}`,
        )
      }
      const workspace = row.dependedByLocation || '.'
      const alias = name.split(':')[0]
      const current =
        typeof row.current === 'string' && row.current
          ? row.current
          : ((workspace === '.'
              ? undefined
              : locked[`${workspace}/node_modules/${alias}`]) ??
            locked[`node_modules/${alias}`] ??
            'missing')
      entries.push({
        name,
        current,
        wanted: String(row.wanted),
        latest: String(row.latest),
        workspace,
      })
    }
  }
  return entries
}

const npm: ManagerAdapter = {
  name: 'npm',
  lockfile: 'package-lock.json',

  readWorkspace: (cwd) => {
    const isWorkspace = hasWorkspacesField(cwd)
    return {
      isWorkspace,
      catalogs: [],
      manifests: readWorkspaceManifests(
        cwd,
        isWorkspace ? workspacePatterns(readManifest(cwd)) : [],
      ),
    }
  },

  discover: async (run, cwd, { isWorkspace }) => {
    // Without --workspaces the report covers the root's dependencies too;
    // --long adds the owning manifest to each row.
    const stdout = await run(
      isWorkspace ? ['outdated', '--json', '--long'] : ['outdated', '--json'],
      { isSuccess: isOutdatedReport },
    )
    const locked = readLockedVersions(cwd)
    return isWorkspace
      ? {
          kind: 'workspace',
          entries: parseNpmWorkspaceOutdated(stdout, locked),
        }
      : { kind: 'single', outdated: parseNpmOutdated(stdout, locked) }
  },

  apply: async (run, cwd, { names, manifests }) => {
    // npm installs the highest version each range allows. Only packages
    // moving past their range need their manifest spec rewritten first, in
    // the manifest that owns it.
    const style = npm.saveStyle(cwd)
    const written = manifests.filter(
      (m) => Object.keys(m.beyondRange).length > 0,
    )
    for (const m of written) {
      await updatePackageJson(path.join(cwd, m.path), m.beyondRange, style)
    }

    // `npm update` at the root moves every workspace's ranges too;
    // `--workspaces` would skip the root's own.
    await run(['update', ...names], { manifestWritten: written.length > 0 })
  },

  /** `save-exact` / `save-prefix` in .npmrc. */
  saveStyle: (cwd) => {
    const npmrc = loadNpmrc(cwd)
    const prefix = npmrc['save-prefix']
    return {
      exact: npmrcBoolean(npmrc['save-exact']) ?? false,
      prefix: typeof prefix === 'string' ? prefix : DEFAULT_SAVE_STYLE.prefix,
    }
  },

  overrides: (cwd) => manifestOverrides(cwd, ['overrides']),
}

export default npm
