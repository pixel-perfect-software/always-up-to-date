import path from 'path'

import type { ManagerAdapter } from '@/managers/adapter'
import { pnpmNpmrcLayers } from '@/managers/pnpm/npmrc'
import { readWorkspaceManifests } from '@/managers/workspaces'
import {
  readPnpmCatalogs,
  splitCatalogUpdates,
  updatePackageJson,
  updatePNPMWorkspaceYAML,
} from '@/utils/files'
import { overridesFromField } from '@/utils/overrides'
import {
  DEFAULT_SAVE_STYLE,
  readTextFile,
  unquote,
  yamlValue,
} from '@/utils/saveStyle'

const readWorkspaceYaml = (cwd: string): string =>
  readTextFile(path.join(cwd, 'pnpm-workspace.yaml'))

/**
 * The `packages` patterns of pnpm-workspace.yaml, as a block list or a flow
 * list. The file also holds settings (`overrides`, `catalog`,
 * `onlyBuiltDependencies`), so single-package projects often have one; the
 * project is a workspace only when it lists at least one pattern.
 */
const workspacePackagePatterns = (yaml: string): string[] => {
  const lines = yaml.split(/\r?\n/)
  const start = lines.findIndex((line) => /^packages:/.test(line))
  if (start === -1) return []

  const inline = lines[start].replace(/^packages:\s*/, '')
  if (inline && !inline.startsWith('#')) {
    const flow = /^\[\s*([^\s\]][^\]]*)\]?/.exec(inline)
    if (!flow) return []
    return flow[1]
      .split(',')
      .map(unquote)
      .filter((pattern) => pattern !== '')
  }

  const patterns: string[] = []
  for (const line of lines.slice(start + 1)) {
    const item = /^\s*-\s*([^\s#].*)$/.exec(line)
    if (item) {
      patterns.push(unquote(item[1].replace(/\s+#.*$/, '')))
    } else if (/^\S/.test(line) && !line.startsWith('#')) {
      break
    }
  }
  return patterns
}

/** The `overrides:` block of pnpm-workspace.yaml, read line by line. */
const readWorkspaceOverrides = (yaml: string): Record<string, string> => {
  const overrides: Record<string, string> = {}
  let inBlock = false
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inBlock = /^overrides:\s*$/.test(line)
      continue
    }
    const entry = inBlock
      ? /^\s+(['"]?)(.+?)\1\s*:\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/.exec(line)
      : null
    if (entry) overrides[entry[2]] = entry[3]
  }
  return overrides
}

/**
 * The install after autd rewrites a manifest or catalog. With `CI` set, pnpm
 * makes a plain `install` frozen and refuses the lockfile the rewrite just
 * made stale (ERR_PNPM_OUTDATED_LOCKFILE, ERR_PNPM_LOCKFILE_CONFIG_MISMATCH).
 */
const INSTALL_AFTER_WRITE = ['install', '--no-frozen-lockfile']

const pnpm: ManagerAdapter = {
  name: 'pnpm',
  lockfile: 'pnpm-lock.yaml',

  readWorkspace: (cwd) => {
    const yaml = readWorkspaceYaml(cwd)
    const patterns = workspacePackagePatterns(yaml)
    return {
      isWorkspace: patterns.length > 0,
      catalogs: readPnpmCatalogs(yaml),
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

    if (!isWorkspace) {
      const manifestWritten = Object.keys(beyondRange).length > 0
      if (Object.keys(catalogs).length === 0) {
        if (manifestWritten) await updatePackageJson(cwd, beyondRange, style)
        await run(['update', ...names], { manifestWritten })
        return
      }

      if (manifestWritten) {
        // Versions live in pnpm-workspace.yaml catalogs or directly in the
        // package.json: a `catalog:` spec moves its own catalog's entry, every
        // other row the manifest.
        const { catalogs: moved, byManifest } = splitCatalogUpdates(cwd, [
          { path: '.', withinRange: [], beyondRange },
        ])
        for (const [catalog, versions] of Object.entries(moved)) {
          await updatePNPMWorkspaceYAML(cwd, versions, style, catalog)
        }
        for (const m of byManifest) {
          await updatePackageJson(cwd, m.versions, style)
        }

        // `pnpm install` re-reads both manifest and pnpm-workspace.yaml
        // and relinks node_modules + lockfile reliably. `pnpm update`
        // can miss catalog mutations.
        await run(INSTALL_AFTER_WRITE, { manifestWritten })
      }
      if (withinRange.length > 0) {
        await run(['update', ...withinRange], { manifestWritten })
      }
      return
    }

    // A row whose owning spec is `catalog:` moves the catalog entry in
    // pnpm-workspace.yaml; every other row moves in the manifest that owns it.
    const { catalogs: moved, byManifest } = splitCatalogUpdates(cwd, manifests)
    const manifestWritten =
      Object.keys(moved).length > 0 || byManifest.length > 0
    for (const [catalog, versions] of Object.entries(moved)) {
      await updatePNPMWorkspaceYAML(cwd, versions, style, catalog)
    }
    for (const m of byManifest) {
      await updatePackageJson(path.join(cwd, m.path), m.versions, style)
    }

    // `pnpm install` re-reads every manifest and pnpm-workspace.yaml and
    // relinks node_modules + lockfile reliably. `pnpm update -r` can miss
    // catalog mutations.
    if (manifestWritten) await run(INSTALL_AFTER_WRITE, { manifestWritten })

    // `install` leaves in-range packages where the lockfile has them.
    if (withinRange.length > 0) {
      await run(['update', '-r', ...withinRange], { manifestWritten })
    }
  },

  /** `saveExact` / `savePrefix` in pnpm-workspace.yaml; pnpm 12 ignores .npmrc for these. */
  saveStyle: (cwd) => {
    const yaml = readWorkspaceYaml(cwd)
    return {
      exact: yamlValue(yaml, 'saveExact') === 'true',
      prefix: yamlValue(yaml, 'savePrefix') ?? DEFAULT_SAVE_STYLE.prefix,
    }
  },

  /** `overrides` in pnpm-workspace.yaml; pnpm 12 ignores `pnpm.overrides` and `resolutions` in package.json. */
  overrides: (cwd) =>
    overridesFromField(
      readWorkspaceOverrides(readWorkspaceYaml(cwd)),
      'overrides in pnpm-workspace.yaml',
    ),
}

export default pnpm
