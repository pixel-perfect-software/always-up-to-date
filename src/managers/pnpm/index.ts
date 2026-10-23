import path from 'path'

import type { SuccessCheck } from '@/commandRunner'
import type { ManagerAdapter } from '@/managers/adapter'
import type { PackageInfo } from '@/types'
import { updatePackageJson, updatePNPMWorkspaceYAML } from '@/utils/files'
import { overridesFromField } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE, readTextFile, yamlValue } from '@/utils/saveStyle'

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

const readWorkspaceYaml = (cwd: string): string =>
  readTextFile(path.join(cwd, 'pnpm-workspace.yaml'))

/**
 * pnpm-workspace.yaml also holds settings (`overrides`, `catalog`,
 * `onlyBuiltDependencies`), so single-package projects often have one. The
 * project is a workspace only when the file lists `packages`, as a block list
 * or a flow list.
 */
const listsWorkspacePackages = (yaml: string): boolean => {
  const lines = yaml.split('\n')
  const start = lines.findIndex((line) => /^packages:/.test(line))
  if (start === -1) return false

  const inline = lines[start].replace(/^packages:\s*/, '')
  if (inline && !inline.startsWith('#')) return /^\[\s*[^\s\]]/.test(inline)

  for (const line of lines.slice(start + 1)) {
    if (/^\s*-\s*[^\s#]/.test(line)) return true
    if (/^\S/.test(line) && !line.startsWith('#')) return false
  }
  return false
}

/**
 * Catalogs in pnpm-workspace.yaml: `catalog` for the default one, and each
 * key of `catalogs:`. A single-package project can have them too.
 */
const catalogNames = (yaml: string): string[] => {
  const names: string[] = []
  let inCatalogs = false
  let keyIndent: number | undefined
  for (const line of yaml.split('\n')) {
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
  for (const line of yaml.split('\n')) {
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

const pnpm: ManagerAdapter = {
  name: 'pnpm',
  lockfile: 'pnpm-lock.yaml',

  readWorkspace: (cwd) => {
    const yaml = readWorkspaceYaml(cwd)
    return {
      isWorkspace: listsWorkspacePackages(yaml),
      catalogs: catalogNames(yaml),
    }
  },

  discover: async (run, _cwd, { isWorkspace }) => {
    const args = isWorkspace
      ? ['outdated', '--json', '-r']
      : ['outdated', '--json']

    // Both reports are needed for `wanted`, so they run in parallel.
    const [report, compatibleReport] = await Promise.all([
      run(args, { isSuccess: isOutdatedReport }),
      run([...args, '--compatible'], { isSuccess: isOutdatedReport }),
    ])
    return parsePnpmOutdated(report, compatibleReport)
  },

  apply: async (
    run,
    cwd,
    { names, withinRange, beyondRange },
    { isWorkspace, catalogs },
  ) => {
    // pnpm installs the highest version each range allows. Only packages
    // moving past their range need their manifest spec rewritten first.
    const manifestWritten = Object.keys(beyondRange).length > 0
    const usesCatalogs = catalogs.length > 0

    if (!isWorkspace && !usesCatalogs) {
      if (manifestWritten) {
        await updatePackageJson(cwd, beyondRange, pnpm.saveStyle(cwd))
      }
      await run(['update', ...names], { manifestWritten })
      return
    }

    if (manifestWritten) {
      // Versions live in pnpm-workspace.yaml catalogs or directly in a
      // package.json. Run both rewrites — each is a no-op for entries it
      // doesn't own, and updatePackageJson skips `catalog:` /
      // `workspace:` refs so it can't clobber catalog references.
      const style = pnpm.saveStyle(cwd)
      if (usesCatalogs) {
        await updatePNPMWorkspaceYAML(cwd, beyondRange, style)
      }
      await updatePackageJson(cwd, beyondRange, style)

      // `pnpm install` re-reads both manifest and pnpm-workspace.yaml
      // and relinks node_modules + lockfile reliably. `pnpm update -r`
      // can miss catalog mutations.
      await run(['install'], { manifestWritten })
    }

    // `install` leaves in-range packages where the lockfile has them.
    if (withinRange.length > 0) {
      await run(
        isWorkspace
          ? ['update', '-r', ...withinRange]
          : ['update', ...withinRange],
        { manifestWritten },
      )
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
