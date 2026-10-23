import path from 'path'

import type { ManagerAdapter } from '@/managers/adapter'
import { hasWorkspacesField, readManifest } from '@/managers/workspaces'
import type { PackageInfo } from '@/types'
import {
  identifyCatalogPackages,
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

  readWorkspace: (cwd) => ({
    isWorkspace: hasWorkspacesField(cwd),
    catalogs: catalogNames(cwd),
  }),

  discover: async (run, _cwd, { isWorkspace }) =>
    parseBunOutdated(
      await run(isWorkspace ? ['outdated', '--filter', '*'] : ['outdated']),
    ),

  apply: async (
    run,
    cwd,
    { names, withinRange, beyondRange, discovered },
    { isWorkspace, catalogs },
  ) => {
    // bun installs the highest version each range allows. Only packages
    // moving past their range need their manifest spec rewritten first.
    const manifestWritten = Object.keys(beyondRange).length > 0

    if (!isWorkspace || catalogs.length === 0) {
      if (manifestWritten) {
        await updatePackageJson(cwd, beyondRange, bun.saveStyle(cwd))
      }
      await run(
        isWorkspace
          ? ['update', ...names, '--filter', '*']
          : ['update', ...names],
        { manifestWritten },
      )
      return
    }

    const { catalogPackages } = identifyCatalogPackages(cwd, discovered)
    const catalogVersions: Record<string, string> = {}
    const rootVersions: Record<string, string> = {}
    for (const [name, version] of Object.entries(beyondRange)) {
      if (catalogPackages.includes(name)) catalogVersions[name] = version
      else rootVersions[name] = version
    }

    if (Object.keys(catalogVersions).length > 0) {
      await updateBunCatalogs(cwd, catalogVersions, bun.saveStyle(cwd))
    }

    if (Object.keys(rootVersions).length > 0) {
      await updatePackageJson(cwd, rootVersions, bun.saveStyle(cwd))
    }

    if (manifestWritten) {
      await run(['install'], { manifestWritten })
    }

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
