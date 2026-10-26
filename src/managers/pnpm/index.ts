import fs from 'fs'
import path from 'path'

import type { SuccessCheck } from '@/commandRunner'
import type { ManagerAdapter } from '@/managers/adapter'
import { applyPnpmRegistrySettings } from '@/managers/pnpm/registries'
import { ownerPath, readWorkspaceManifests } from '@/managers/workspaces'
import { StepError } from '@/stepError'
import type { OutdatedEntry, PackageInfo } from '@/types'
import {
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

/**
 * `pnpm outdated` exits 1 whenever something is outdated. On real errors it
 * also exits 1, with the error on stderr and no report on stdout.
 */
const isOutdatedReport: SuccessCheck = ({ exitCode, stdout }) => {
  if (exitCode === 0) return true
  if (exitCode !== 1) return false
  try {
    const report = JSON.parse(stdout)
    return typeof report === 'object' && report !== null
  } catch {
    return false
  }
}

/**
 * pnpm's `wanted` is the lockfile's version, not the highest version the
 * range allows. `outdated --compatible` reports that one as `latest`, so
 * `wanted` is taken from there.
 */
export const parsePnpmOutdated = (
  report: string,
  compatibleReport: string,
): Record<string, PackageInfo> => {
  const parsed: Record<string, PackageInfo> = JSON.parse(report || '{}')
  const compatible: Record<string, PackageInfo> = JSON.parse(
    compatibleReport || '{}',
  )
  for (const [name, info] of Object.entries(parsed)) {
    info.wanted = compatible[name]?.latest ?? info.wanted
  }
  return parsed
}

interface PnpmOutdatedRow {
  current?: string
  wanted: string
  latest: string
  dependentPackages?: { name: string; location: string }[]
}

/**
 * One entry per package per workspace package that depends on it. pnpm keys
 * a name by `name@current` when owners are at different versions, so that
 * suffix comes off, and reports each owner's directory as an absolute
 * `location`, made relative to `cwd`.
 */
const pnpmEntries = (report: string, cwd: string): OutdatedEntry[] => {
  const parsed: Record<string, PnpmOutdatedRow> = JSON.parse(report || '{}')
  const entries: OutdatedEntry[] = []
  for (const [key, row] of Object.entries(parsed)) {
    const suffix = `@${row.current}`
    const name =
      row.current && key.endsWith(suffix) && key !== suffix
        ? key.slice(0, -suffix.length)
        : key
    // Every row of a recursive report names its owners; one without them
    // can't be attributed, and dropping it would read as "up to date".
    if (!Array.isArray(row.dependentPackages)) {
      throw new StepError(
        'discover',
        `pnpm outdated -r reported ${name} with no dependentPackages`,
      )
    }
    for (const { location } of row.dependentPackages) {
      entries.push({
        name,
        current: row.current ?? 'missing',
        wanted: row.wanted,
        latest: row.latest,
        workspace: ownerPath('pnpm', name, path.relative(cwd, location)),
      })
    }
  }
  return entries
}

/**
 * `pnpm outdated -r --json`: one entry per (package, manifest). `wanted` is
 * taken from the `--compatible` report's `latest` for the same manifest and
 * name, as in single-package projects.
 */
export const parsePnpmWorkspaceOutdated = (
  report: string,
  compatibleReport: string,
  cwd: string,
): OutdatedEntry[] => {
  const compatible = new Map(
    pnpmEntries(compatibleReport, cwd).map((entry) => [
      `${entry.workspace}\0${entry.name}`,
      entry,
    ]),
  )
  return pnpmEntries(report, cwd).map((entry) => ({
    ...entry,
    wanted:
      compatible.get(`${entry.workspace}\0${entry.name}`)?.latest ??
      entry.wanted,
  }))
}

/**
 * The directory pnpm reads its project settings from: the nearest one,
 * walking up from `cwd`, that holds a pnpm-workspace.yaml. From a member that
 * is the workspace root, and its yaml and .npmrc are the only project files
 * read (verified on pnpm 12.15.0, 2026-10-26: a member's own .npmrc is
 * ignored, and a member with a yaml of its own is its own root).
 */
const pnpmProjectRoot = (cwd: string): string => {
  for (let dir = path.resolve(cwd); ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    if (path.dirname(dir) === dir) return path.resolve(cwd)
  }
}

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

/**
 * Catalogs in pnpm-workspace.yaml: `catalog` for the default one, and each
 * key of `catalogs:`. A single-package project can have them too.
 */
const catalogNames = (yaml: string): string[] => {
  const names: string[] = []
  let inCatalogs = false
  let keyIndent: number | undefined
  for (const line of yaml.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inCatalogs = /^catalogs:/.test(line)
      keyIndent = undefined
      if (/^catalog:/.test(line)) names.push('catalog')
      continue
    }
    const key = inCatalogs ? /^( +)(['"]?)([^'"#\s:]+)\2\s*:/.exec(line) : null
    if (!key) continue
    keyIndent ??= key[1].length
    if (key[1].length === keyIndent) names.push(key[3])
  }
  return names
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
      catalogs: catalogNames(yaml),
      manifests: readWorkspaceManifests(cwd, patterns),
    }
  },

  projectRoot: pnpmProjectRoot,

  registryConfig: (cwd, fromNpmrc) =>
    applyPnpmRegistrySettings(
      fromNpmrc,
      readTextFile(path.join(pnpmProjectRoot(cwd), 'pnpm-workspace.yaml')),
    ),

  discover: async (run, cwd, { isWorkspace }) => {
    const args = isWorkspace
      ? ['outdated', '--json', '-r']
      : ['outdated', '--json']

    // Both reports are needed for `wanted`, so they run in parallel.
    const [report, compatibleReport] = await Promise.all([
      run(args, { isSuccess: isOutdatedReport }),
      run([...args, '--compatible'], { isSuccess: isOutdatedReport }),
    ])
    return isWorkspace
      ? {
          kind: 'workspace',
          entries: parsePnpmWorkspaceOutdated(report, compatibleReport, cwd),
        }
      : {
          kind: 'single',
          outdated: parsePnpmOutdated(report, compatibleReport),
        }
  },

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
      if (catalogs.length === 0) {
        if (manifestWritten) await updatePackageJson(cwd, beyondRange, style)
        await run(['update', ...names], { manifestWritten })
        return
      }

      if (manifestWritten) {
        // Versions live in pnpm-workspace.yaml catalogs or directly in a
        // package.json. Run both rewrites: each is a no-op for entries it
        // doesn't own, and updatePackageJson skips `catalog:` /
        // `workspace:` refs so it can't clobber catalog references.
        await updatePNPMWorkspaceYAML(cwd, beyondRange, style)
        await updatePackageJson(cwd, beyondRange, style)

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
    const { catalog, byManifest } = splitCatalogUpdates(cwd, manifests)
    const manifestWritten =
      Object.keys(catalog).length > 0 || byManifest.length > 0
    if (Object.keys(catalog).length > 0) {
      await updatePNPMWorkspaceYAML(cwd, catalog, style)
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
