import path from 'path'

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
import {
  splitCatalogUpdates,
  updateBunCatalogs,
  updatePackageJson,
} from '@/utils/files'
import { loadNpmrc, npmrcBoolean } from '@/utils/npmrcLoader'
import { manifestOverrides } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE, readTextFile } from '@/utils/saveStyle'

/**
 * `bun outdated` prints a table: `| Package | Current | Update | Latest |`.
 * The Update column is the highest version the range allows.
 */
export const parseBunOutdated = (
  output: string,
): Record<string, PackageInfo> => {
  const result: Record<string, PackageInfo> = {}

  // Split output into lines and filter out header/separator lines
  const lines = output
    .split('\n')
    .filter(
      (line) =>
        line.trim() &&
        !line.includes('|---') &&
        !line.includes('Package') &&
        line.includes('|'),
    )

  for (const line of lines) {
    // Split by | and clean up whitespace
    const columns = line
      .split('|')
      .map((col) => col.trim())
      .filter((col) => col)

    if (columns.length >= 4) {
      const packageNameRaw = columns[0]
      const current = columns[1]
      // bun's "Update" column: the highest version the range allows.
      const wanted = columns[2]
      const latest = columns[3]

      // Extract package name (remove dev/prod indicators)
      const packageName = packageNameRaw
        .replace(/\s*\(dev\)|\s*\(prod\)/, '')
        .trim()

      // Only include packages that have updates available (current !== latest)
      if (current !== latest) {
        result[packageName] = {
          name: packageName,
          current,
          wanted,
          latest,
        }
      }
    }
  }

  return result
}

/**
 * `bun outdated --filter '*'` in a workspace project: the table gains a
 * `Workspace` column holding a workspace's package name, which `ownerOf`
 * turns into the manifest's directory. Cells are read by position, so an
 * empty one (a root without a `name`) stays a column.
 */
export const parseBunWorkspaceOutdated = (
  output: string,
  ownerOf: (workspaceName: string) => string,
): OutdatedEntry[] => {
  const rows = output
    .split('\n')
    .filter((line) => line.startsWith('|') && !line.startsWith('|-'))
    .map((line) =>
      line
        .replace(/^\|/, '')
        .replace(/\|\s*$/, '')
        .split('|')
        .map((cell) => cell.trim()),
    )
  const [header, ...body] = rows
  if (!header) return []

  const column = (title: string): number => {
    const index = header.indexOf(title)
    if (index === -1) {
      throw new StepError(
        'discover',
        `bun outdated --filter printed no ${title} column`,
      )
    }
    return index
  }
  const [name, current, wanted, latest, workspace] = [
    'Package',
    'Current',
    'Update',
    'Latest',
    'Workspace',
  ].map(column)

  return body
    .filter((row) => row[current] !== row[latest])
    .map((row) => ({
      name: row[name].replace(/\s*\((?:dev|prod|peer|optional)\)/, '').trim(),
      current: row[current],
      wanted: row[wanted],
      latest: row[latest],
      workspace: ownerOf(row[workspace]),
    }))
}

/** `exact = true` inside bunfig.toml's `[install]` table. */
const bunfigExact = (content: string): boolean => {
  let inInstall = false
  for (const line of content.split('\n')) {
    const table = /^\s*\[([^\]]+)\]/.exec(line)
    if (table) {
      inInstall = table[1].trim() === 'install'
      continue
    }
    if (inInstall && /^\s*exact\s*=\s*true\s*(#.*)?$/.test(line)) return true
  }
  return false
}

/**
 * Catalogs in package.json: `catalog` (the default one) and the keys of
 * `catalogs` (named ones).
 */
const catalogNames = (cwd: string): string[] => {
  const manifest = readManifest(cwd)
  const names: string[] = []
  if (manifest?.catalog && typeof manifest.catalog === 'object') {
    names.push('catalog')
  }
  if (manifest?.catalogs && typeof manifest.catalogs === 'object') {
    names.push(...Object.keys(manifest.catalogs))
  }
  return names
}

const bun: ManagerAdapter = {
  name: 'bun',
  lockfile: 'bun.lock',

  readWorkspace: (cwd) => {
    const isWorkspace = hasWorkspacesField(cwd)
    return {
      isWorkspace,
      catalogs: catalogNames(cwd),
      manifests: readWorkspaceManifests(
        cwd,
        isWorkspace ? workspacePatterns(readManifest(cwd)) : [],
      ),
    }
  },

  discover: async (run, _cwd, { isWorkspace, manifests }) => {
    const output = await run(
      isWorkspace ? ['outdated', '--filter', '*'] : ['outdated'],
    )
    return isWorkspace
      ? {
          kind: 'workspace',
          entries: parseBunWorkspaceOutdated(
            output,
            workspaceOwner(manifests, 'bun'),
          ),
        }
      : { kind: 'single', outdated: parseBunOutdated(output) }
  },

  apply: async (
    run,
    cwd,
    { names, withinRange, beyondRange, manifests },
    { isWorkspace, catalogs },
  ) => {
    // bun installs the highest version each range allows. Only packages
    // moving past their range need their manifest spec rewritten first.
    const style = bun.saveStyle(cwd)

    if (!isWorkspace) {
      const manifestWritten = Object.keys(beyondRange).length > 0
      if (manifestWritten) await updatePackageJson(cwd, beyondRange, style)
      await run(['update', ...names], { manifestWritten })
      return
    }

    // A row whose owning spec is `catalog:` moves the catalog entry (in the
    // root package.json); every other row moves in the manifest that owns it.
    const { catalog, byManifest } = splitCatalogUpdates(cwd, manifests)
    const manifestWritten =
      Object.keys(catalog).length > 0 || byManifest.length > 0
    if (Object.keys(catalog).length > 0) {
      await updateBunCatalogs(cwd, catalog, style)
    }
    for (const m of byManifest) {
      await updatePackageJson(path.join(cwd, m.path), m.versions, style)
    }

    if (catalogs.length === 0) {
      await run(['update', ...names, '--filter', '*'], { manifestWritten })
      return
    }

    if (manifestWritten) await run(['install'], { manifestWritten })

    // `install` leaves in-range packages where the lockfile has them.
    if (withinRange.length > 0) {
      await run(['update', ...withinRange, '--filter', '*'], {
        manifestWritten,
      })
    }
  },

  /** `exact` in bunfig.toml's `[install]`, or `save-exact` in .npmrc; bun has no prefix setting. */
  saveStyle: (cwd) => ({
    exact:
      bunfigExact(readTextFile(path.join(cwd, 'bunfig.toml'))) ||
      (npmrcBoolean(loadNpmrc(cwd)['save-exact']) ?? false),
    prefix: DEFAULT_SAVE_STYLE.prefix,
  }),

  overrides: (cwd) => manifestOverrides(cwd, ['overrides', 'resolutions']),
}

export default bun
