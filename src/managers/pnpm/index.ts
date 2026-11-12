import semver from 'semver'

import type { ManagerAdapter } from '@/managers/adapter'
import { writeBeyondRange } from '@/managers/beyondRange'
import { pnpmNpmrcLayers } from '@/managers/pnpm/npmrc'
import { pnpmReleaseAgeGate } from '@/managers/pnpm/releaseAge'
import {
  pnpmCatalogs,
  pnpmOverrides,
  pnpmPackages,
  pnpmSetting,
  readPnpmWorkspaceYaml,
} from '@/managers/pnpm/workspaceYaml'
import {
  pnpmWorkspaceRoot,
  readWorkspaceManifests,
} from '@/managers/workspaces'
import { updatePNPMWorkspaceYAML } from '@/utils/catalogs'
import { readInstalledGraph } from '@/utils/installedGraph'
import { updatePackageJson } from '@/utils/manifests'
import { overridesFromField } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE } from '@/utils/saveStyle'

export { pnpmWorkspaceRoot }

/**
 * The install after autd rewrites a manifest or catalog. With `CI` set, pnpm
 * makes a plain `install` frozen and refuses the lockfile the rewrite just
 * made stale (ERR_PNPM_OUTDATED_LOCKFILE, ERR_PNPM_LOCKFILE_CONFIG_MISMATCH).
 */
const INSTALL_AFTER_WRITE = ['install', '--no-frozen-lockfile']

const pnpm: ManagerAdapter = {
  name: 'pnpm',
  lockfile: 'pnpm-lock.yaml',

  projectRoot: pnpmWorkspaceRoot,

  readWorkspace: (cwd) => {
    const yaml = readPnpmWorkspaceYaml(cwd)
    const patterns = pnpmPackages(yaml)
    return {
      isWorkspace: patterns.length > 0,
      catalogs: pnpmCatalogs(yaml),
      manifests: readWorkspaceManifests(cwd, patterns),
    }
  },

  npmrcLayers: pnpmNpmrcLayers,

  // pnpm fails on an empty default registry and on an empty scope route.
  emptyRegistry: { registry: true, scopes: true },

  apply: async (
    run,
    cwd,
    { names, withinRange, beyondRange, manifests },
    { isWorkspace, catalogs },
  ) => {
    // pnpm installs the highest version each range allows. Only packages
    // moving past their range need their manifest spec rewritten first.
    const style = pnpm.saveStyle(cwd)

    if (!isWorkspace && Object.keys(catalogs).length === 0) {
      const manifestWritten = Object.keys(beyondRange).length > 0
      if (manifestWritten) await updatePackageJson(cwd, beyondRange, style)
      await run(['update', ...names], { manifestWritten })
      return
    }

    // With catalogs, a single package is a workspace of one manifest: a row
    // whose owning spec is `catalog:` moves the catalog entry in
    // pnpm-workspace.yaml, every other row the manifest that owns it.
    const manifestWritten = await writeBeyondRange(
      cwd,
      isWorkspace ? manifests : [{ path: '.', withinRange: [], beyondRange }],
      { style, writeCatalog: updatePNPMWorkspaceYAML, manager: pnpm.name },
    )

    // `pnpm install` re-reads every manifest and pnpm-workspace.yaml and
    // relinks node_modules + lockfile reliably. `pnpm update` can miss
    // catalog mutations.
    if (manifestWritten) await run(INSTALL_AFTER_WRITE, { manifestWritten })

    // `install` leaves in-range packages where the lockfile has them.
    if (withinRange.length > 0) {
      const recursive = isWorkspace ? ['-r'] : []
      await run(['update', ...recursive, ...withinRange], { manifestWritten })
    }
  },

  /** `saveExact` / `savePrefix` in pnpm-workspace.yaml; pnpm 12 ignores .npmrc for these. */
  // `node_modules/.pnpm/lock.yaml`: what each package was installed with.
  installedGraph: (cwd) => readInstalledGraph(cwd),
  saveStyle: (cwd) => {
    const yaml = readPnpmWorkspaceYaml(cwd)
    return {
      exact: pnpmSetting(yaml, 'saveExact') === 'true',
      prefix: pnpmSetting(yaml, 'savePrefix') ?? DEFAULT_SAVE_STYLE.prefix,
    }
  },

  /** `overrides` in pnpm-workspace.yaml; pnpm 12 ignores `pnpm.overrides` and `resolutions` in package.json. */
  pinning: () => ({
    install: INSTALL_AFTER_WRITE,
    writeCatalog: updatePNPMWorkspaceYAML,
  }),

  // pnpm 12 gates versions younger than one day unless set (#168).
  releaseAgeGate: (cwd, sources) => pnpmReleaseAgeGate(cwd, sources),

  /** `nodeVersion` in pnpm-workspace.yaml: pnpm 12 judges `engines.node` by it when set (probed 2026-11-07). */
  nodeVersion: (cwd) => {
    const version = pnpmSetting(readPnpmWorkspaceYaml(cwd), 'nodeVersion')
    return version && semver.valid(version) ? version : undefined
  },

  overrides: (cwd) =>
    overridesFromField(
      pnpmOverrides(readPnpmWorkspaceYaml(cwd)),
      'overrides in pnpm-workspace.yaml',
    ),
}

export default pnpm
