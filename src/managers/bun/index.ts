import path from 'path'

import type { ManagerAdapter } from '@/managers/adapter'
import { packageJsonWorkspace, readManifest } from '@/managers/workspaces'
import {
  readBunCatalogs,
  splitCatalogUpdates,
  updateBunCatalogs,
  updatePackageJson,
} from '@/utils/files'
import { loadNpmrc, npmrcBoolean } from '@/utils/npmrcLoader'
import { manifestOverrides } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE, readTextFile } from '@/utils/saveStyle'

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

const bun: ManagerAdapter = {
  name: 'bun',
  lockfile: 'bun.lock',

  readWorkspace: (cwd) => ({
    ...packageJsonWorkspace(cwd),
    catalogs: readBunCatalogs(readManifest(cwd)),
  }),

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
    const { catalogs: moved, byManifest } = splitCatalogUpdates(cwd, manifests)
    const manifestWritten =
      Object.keys(moved).length > 0 || byManifest.length > 0
    for (const [catalog, versions] of Object.entries(moved)) {
      await updateBunCatalogs(cwd, versions, style, catalog)
    }
    for (const m of byManifest) {
      await updatePackageJson(path.join(cwd, m.path), m.versions, style)
    }

    if (Object.keys(catalogs).length === 0) {
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
