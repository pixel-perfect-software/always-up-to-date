import path from 'path'

import type { ManagerAdapter } from '@/managers/adapter'
import { writeBeyondRange } from '@/managers/beyondRange'
import {
  bunfigExact,
  bunRegistryConfig,
  bunReleaseAgeGate,
} from '@/managers/bun/bunfig'
import { bunNpmrcLayers } from '@/managers/bun/npmrc'
import {
  packageJsonWorkspace,
  packageJsonWorkspaceRoot,
  readManifest,
} from '@/managers/workspaces'
import { readBunCatalogs, updateBunCatalogs } from '@/utils/catalogs'
import { updatePackageJson } from '@/utils/manifests'
import { npmrcBoolean } from '@/utils/npmrc'
import { mergeNpmrcLayers, processSources } from '@/utils/npmrcLoader'
import { manifestOverrides } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE, readTextFile } from '@/utils/saveStyle'

const bun: ManagerAdapter = {
  name: 'bun',
  lockfile: 'bun.lock',

  projectRoot: packageJsonWorkspaceRoot,

  readWorkspace: (cwd) => ({
    ...packageJsonWorkspace(cwd),
    catalogs: readBunCatalogs(readManifest(cwd)),
  }),

  npmrcLayers: bunNpmrcLayers,

  // bun ignores an empty registry or scope route.
  emptyRegistry: { registry: false, scopes: false },

  registryConfig: bunRegistryConfig,

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
    const manifestWritten = await writeBeyondRange(cwd, manifests, {
      style,
      writeCatalog: updateBunCatalogs,
      manager: bun.name,
    })

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

  /**
   * `exact` in bunfig.toml's `[install]`, or `save-exact` in bun's own .npmrc
   * layers (not npm's); bun has no prefix setting. Each call re-reads the two
   * files, a small cost next to an update.
   */
  saveStyle: (cwd) => ({
    exact:
      bunfigExact(readTextFile(path.join(cwd, 'bunfig.toml'))) ||
      (npmrcBoolean(
        mergeNpmrcLayers(bunNpmrcLayers(cwd, processSources())).values[
          'save-exact'
        ],
      ) ??
        false),
    prefix: DEFAULT_SAVE_STYLE.prefix,
  }),

  pinning: () => ({ install: ['install'], writeCatalog: updateBunCatalogs }),

  // bun's minimumReleaseAge (#168), off unless set.
  releaseAgeGate: (cwd, sources) => bunReleaseAgeGate(cwd, sources),

  overrides: (cwd) => manifestOverrides(cwd, ['overrides', 'resolutions']),
}

export default bun
