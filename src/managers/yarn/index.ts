import fs from 'fs'
import path from 'path'

import type { ManagerAdapter } from '@/managers/adapter'
import { packageJsonWorkspace, readManifest } from '@/managers/workspaces'
import {
  applyBerry,
  discoverBerry,
  installedBerry,
} from '@/managers/yarn/berry'
import { StepError } from '@/stepError'
import type { OutdatedEntry, PackageInfo } from '@/types'
import { logger } from '@/utils'
import { buildUpdateDescriptors, type DescriptorField } from '@/utils/files'
import { readInstalledVersions } from '@/utils/installed'
import { manifestOverrides } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE, readTextFile, yamlValue } from '@/utils/saveStyle'

/**
 * Yarn 2+ ("berry") is identified by the `packageManager` field when it is
 * present, otherwise by a `.yarnrc.yml`, which yarn v1 does not use.
 */
export const isYarnBerry = (cwd: string): boolean => {
  const declared = /^yarn@(\d+)\./.exec(
    String(readManifest(cwd)?.packageManager ?? ''),
  )
  if (declared) return Number(declared[1]) >= 2

  return fs.existsSync(path.join(cwd, '.yarnrc.yml'))
}

/**
 * `yarn outdated --json` (v1): NDJSON lines, one of them a table whose rows
 * are `[name, current, wanted, latest, …]`.
 */
export const parseYarnOutdated = (
  output: string,
): Record<string, PackageInfo> => {
  if (!output || output.trim() === '') {
    return {}
  }

  try {
    const lines = output
      .trim()
      .split('\n')
      .filter((line) => line.trim())
    const parsedLines = lines.map((line) => JSON.parse(line))

    // Find the table data from yarn outdated output
    const tableData = parsedLines.find((item) => item.type === 'table')

    if (!tableData || !tableData.data || !tableData.data.body) {
      return {}
    }

    // Transform table data into a more usable format
    const outdatedPackages: Record<string, PackageInfo> = {}

    tableData.data.body.forEach((row: string[]) => {
      if (row.length >= 4) {
        const [packageName, current, wanted, latest] = row
        outdatedPackages[packageName] = {
          name: packageName,
          current,
          wanted,
          latest,
        }
      }
    })

    return outdatedPackages
  } catch (error) {
    logger.error(`Failed to parse yarn outdated output: ${error}`)
    return {}
  }
}

/**
 * `yarn outdated --json --recursive` (v1) in a workspace project: the table's
 * header names the columns, and each body row is one package in one workspace.
 * The `Workspace` column holds a workspace's package name, `ownerOf` turns it
 * into the manifest's directory. Unlike the single-package parser, output it
 * cannot read fails discovery.
 */
export const parseYarnWorkspaceOutdated = (
  output: string,
  ownerOf: (workspaceName: string) => string,
): OutdatedEntry[] => {
  if (!output.trim()) return []

  const lines = output.split('\n').filter((line) => line.trim())
  const table = lines
    .map((line) => JSON.parse(line))
    .find((item) => item?.type === 'table')
  const head: unknown = table?.data?.head
  const body: unknown = table?.data?.body
  if (!Array.isArray(head) || !Array.isArray(body)) return []

  const column = (title: string): number => {
    const index = head.indexOf(title)
    if (index === -1) {
      throw new StepError(
        'discover',
        `yarn outdated --recursive printed no ${title} column`,
      )
    }
    return index
  }
  const [name, current, wanted, latest, workspace] = [
    'Package',
    'Current',
    'Wanted',
    'Latest',
    'Workspace',
  ].map(column)

  return (body as string[][]).map((row) => ({
    name: row[name],
    current: row[current],
    wanted: row[wanted],
    latest: row[latest],
    workspace: ownerOf(row[workspace]),
  }))
}

/** The `yarn workspace <name> upgrade` flag that keeps each field's packages in it. */
const MEMBER_FIELD_FLAGS: [DescriptorField, string[]][] = [
  ['dependencies', []],
  ['devDependencies', ['-D']],
  ['optionalDependencies', ['-O']],
]

const yarn: ManagerAdapter = {
  name: 'yarn',
  lockfile: 'yarn.lock',

  readWorkspace: (cwd) => ({
    ...packageJsonWorkspace(cwd),
    catalogs: {},
  }),

  ownDiscovery: (cwd) =>
    isYarnBerry(cwd)
      ? (run, { isWorkspace }) => discoverBerry(run, isWorkspace)
      : undefined,

  apply: async (
    run,
    cwd,
    { withinRange, beyondRange, manifests },
    { isWorkspace, manifests: members },
  ) => {
    // berry: autd writes the specs that move past their range, yarn locks.
    if (isYarnBerry(cwd)) {
      return applyBerry(
        run,
        cwd,
        { withinRange, manifests },
        yarn.saveStyle(cwd),
      )
    }

    // v1 rewrites the manifest itself and refuses to upgrade against a
    // pre-written package.json ("Outdated lockfile"). Hand it `name@spec`
    // descriptors instead: the current spec for in-range packages, the new
    // version with the entry's decorator for packages moving past it.
    const style = yarn.saveStyle(cwd)

    // No `--recursive`: v1 ignores it.
    if (!isWorkspace) {
      const { descriptors, notInManifest } = buildUpdateDescriptors(cwd, {
        withinRange,
        newVersions: beyondRange,
        style,
      })

      if (notInManifest.length > 0) {
        logger.warn(
          `Skipped ${notInManifest.join(', ')}: not listed in the root package.json.`,
        )
      }

      if (descriptors.length > 0) {
        await run(['upgrade', ...descriptors], { manifestWritten: false })
      }
      return
    }

    // v1 workspaces: `yarn upgrade` at the root only touches the root's
    // manifest, so each member with something moving gets its own
    // `yarn workspace <name> upgrade`, and yarn writes every manifest.
    let memberRan = false
    for (const m of manifests) {
      const { descriptors, byField, notInManifest } = buildUpdateDescriptors(
        path.join(cwd, m.path),
        { withinRange: m.withinRange, newVersions: m.beyondRange, style },
      )

      if (notInManifest.length > 0) {
        logger.warn(
          m.path === '.'
            ? `Skipped ${notInManifest.join(', ')}: not listed in the root package.json.`
            : `Skipped ${notInManifest.join(', ')}: not listed in ${m.path}/package.json.`,
        )
      }
      if (descriptors.length === 0) continue

      if (m.path === '.') {
        await run(['upgrade', ...descriptors], { manifestWritten: false })
        continue
      }

      const name = members.find((w) => w.path === m.path)?.name
      if (!name) {
        throw new StepError(
          'apply',
          `${m.path}/package.json has no name, so yarn cannot upgrade it as a workspace`,
        )
      }
      // `yarn workspace <name> upgrade` writes a devDependency into
      // `dependencies` as well unless told its field (1.22.22), so each
      // field gets its own command with that field's flag.
      for (const [field, flags] of MEMBER_FIELD_FLAGS) {
        if (byField[field].length === 0) continue
        await run(['workspace', name, 'upgrade', ...flags, ...byField[field]], {
          manifestWritten: false,
        })
      }
      memberRan = true
    }

    // A member's upgrade leaves node_modules unlinked until an install.
    if (memberRan) await run(['install'], { manifestWritten: false })
  },

  /**
   * berry locks versions in `yarn.lock` and, under PnP, has no node_modules,
   * so the versions come from `yarn info`. Yarn v1 reads node_modules.
   */
  installed: (run, cwd, rows) =>
    isYarnBerry(cwd)
      ? installedBerry(run, rows)
      : Promise.resolve(readInstalledVersions(cwd, rows)),

  /** berry: `defaultSemverRangePrefix` in .yarnrc.yml, where `''` means exact. Yarn v1 keeps the default. */
  saveStyle: (cwd) => {
    if (!isYarnBerry(cwd)) return DEFAULT_SAVE_STYLE
    const prefix = yamlValue(
      readTextFile(path.join(cwd, '.yarnrc.yml')),
      'defaultSemverRangePrefix',
    )
    if (prefix === undefined) return DEFAULT_SAVE_STYLE
    return { exact: prefix === '', prefix }
  },

  /**
   * `resolutions`, on berry only. Yarn v1 applies them to transitive
   * dependencies but not to a direct one (verified on 1.22.22: the direct
   * dependency still moved), so there is nothing to hold.
   */
  overrides: (cwd) =>
    isYarnBerry(cwd) ? manifestOverrides(cwd, ['resolutions']) : {},
}

export default yarn
