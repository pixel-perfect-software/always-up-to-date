import fs from 'fs'
import path from 'path'

import { StepError } from '@/stepError'
import type { ManifestPlan, PinnedRow } from '@/types'
import { readSpec, splitCatalogUpdates, updatePackageJson } from '@/utils/files'
import type { SaveStyle } from '@/utils/saveStyle'
import type { ManagerAdapter, RunManager } from './adapter'

/** The rows as one beyond-range plan per manifest, which the writers take. */
const plansFor = (rows: PinnedRow[]): ManifestPlan[] => {
  const byPath = new Map<string, ManifestPlan>()
  for (const { path: at, name, version } of rows) {
    let plan = byPath.get(at)
    if (!plan) {
      plan = { path: at, withinRange: [], beyondRange: {} }
      byPath.set(at, plan)
    }
    plan.beyondRange[name] = version
  }
  return [...byPath.values()]
}

/**
 * Moves cooldown fallbacks (#147), before the rest of apply. Asked by name, a
 * manager installs the newest version the range allows, which is the one
 * cooldown held. So each row's exact version is written into its manifest (or
 * catalog) and installed; then the manifests are put back byte for byte, a
 * row past its range has its spec moved to the version as a beyond-range row
 * does, and a second install keeps the locked version, which the specs still
 * allow. A manager whose lockfile is keyed by spec (yarn) relocks first.
 */
export const applyPinned = async (
  run: RunManager,
  cwd: string,
  rows: PinnedRow[],
  adapter: Pick<ManagerAdapter, 'name' | 'pinning' | 'saveStyle'>,
): Promise<void> => {
  const { install, writeCatalog, relock } = adapter.pinning(cwd)
  const style = adapter.saveStyle(cwd)

  const write = async (plans: ManifestPlan[], as: SaveStyle) => {
    const { catalogs, byManifest } = splitCatalogUpdates(cwd, plans)
    for (const [catalog, versions] of Object.entries(catalogs)) {
      if (!writeCatalog) {
        throw new StepError(
          'apply',
          `${adapter.name} has no catalogs, but ${Object.keys(versions).join(', ')} read one`,
        )
      }
      await writeCatalog(cwd, versions, as, catalog)
    }
    for (const m of byManifest) {
      await updatePackageJson(path.join(cwd, m.path), m.versions, as)
    }
  }

  // Every file a pin can touch: each row's manifest, and the catalogs (pnpm's
  // yaml, bun's root package.json).
  const files = [
    ...new Set([
      path.join(cwd, 'package.json'),
      path.join(cwd, 'pnpm-workspace.yaml'),
      ...rows.map((row) => path.join(cwd, row.path, 'package.json')),
    ]),
  ]
  const original = new Map<string, string>()
  for (const file of files) {
    if (fs.existsSync(file)) original.set(file, fs.readFileSync(file, 'utf8'))
  }

  await write(plansFor(rows), { ...style, pin: true })
  await run(install, { manifestWritten: true })

  for (const [file, text] of original) fs.writeFileSync(file, text, 'utf8')
  await write(plansFor(rows.filter((row) => row.beyondRange)), style)

  if (relock) {
    const pins = rows.map((row) => ({
      workspace: row.path,
      name: row.name,
      range: readSpec(path.join(cwd, row.path), row.name) ?? '',
      installed: row.version,
    }))
    try {
      relock(cwd, pins)
    } catch (error) {
      throw new StepError(
        'apply',
        `could not record the restored ranges in ${adapter.name}'s lockfile: ${(error as Error).message}`,
        { manifestWritten: true, cause: error },
      )
    }
  }
  await run(install, { manifestWritten: true })
}
