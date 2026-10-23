import fs from 'fs'
import path from 'path'

import type { SuccessCheck } from '@/commandRunner'
import type { ManagerAdapter } from '@/managers/adapter'
import {
  hasWorkspacesField,
  readManifest,
  readWorkspaceManifests,
  workspaceOwner,
  workspacePatterns,
} from '@/managers/workspaces'
import { StepError } from '@/stepError'
import type { OutdatedEntry, PackageInfo } from '@/types'
import { logger } from '@/utils'
import { buildUpdateDescriptors } from '@/utils/files'
import { manifestOverrides } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE, readTextFile, yamlValue } from '@/utils/saveStyle'

/**
 * `yarn outdated` (v1) exits 1 whenever something is outdated, printing a
 * `{"type":"table"}` line. On real errors it also exits 1, with no table.
 */
const isOutdatedReport: SuccessCheck = ({ exitCode, stdout }) => {
  if (exitCode === 0) return true
  if (exitCode !== 1) return false
  return stdout.split('\n').some((line) => {
    try {
      return JSON.parse(line)?.type === 'table'
    } catch {
      return false
    }
  })
}

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

const yarn: ManagerAdapter = {
  name: 'yarn',
  lockfile: 'yarn.lock',

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

  discover: async (run, _cwd, { isWorkspace, manifests }) => {
    const output = await run(
      isWorkspace
        ? ['outdated', '--json', '--recursive']
        : ['outdated', '--json'],
      { isSuccess: isOutdatedReport },
    )
    return isWorkspace
      ? {
          kind: 'workspace',
          entries: parseYarnWorkspaceOutdated(
            output,
            workspaceOwner(manifests, 'yarn'),
          ),
        }
      : { kind: 'single', outdated: parseYarnOutdated(output) }
  },

  apply: async (
    run,
    cwd,
    { withinRange, beyondRange, manifests },
    { isWorkspace, manifests: members },
  ) => {
    // yarn rewrites the manifest itself: v1 refuses to upgrade against a
    // pre-written package.json ("Outdated lockfile"). Hand it `name@spec`
    // descriptors instead: the current spec for in-range packages, the new
    // version with the entry's decorator for packages moving past it.
    const style = yarn.saveStyle(cwd)
    const berry = isYarnBerry(cwd)

    // v1 is `upgrade`, berry is `up`; neither has `update`. No
    // `--recursive`: v1 ignores it and berry's means "re-resolve
    // transitive dependencies", which rejects explicit ranges.
    const subcommand = berry ? 'up' : 'upgrade'

    if (!isWorkspace || berry) {
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
        await run([subcommand, ...descriptors], { manifestWritten: false })
      }
      return
    }

    // v1 workspaces: `yarn upgrade` at the root only touches the root's
    // manifest, so each member with something moving gets its own
    // `yarn workspace <name> upgrade`, and yarn writes every manifest.
    let memberRan = false
    for (const m of manifests) {
      const { descriptors, notInManifest } = buildUpdateDescriptors(
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
      await run(['workspace', name, 'upgrade', ...descriptors], {
        manifestWritten: false,
      })
      memberRan = true
    }

    // A member's upgrade leaves node_modules unlinked until an install.
    if (memberRan) await run(['install'], { manifestWritten: false })
  },

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
