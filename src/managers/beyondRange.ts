import path from 'path'

import { StepError } from '@/stepError'
import type { ManifestPlan } from '@/types'
import { splitCatalogUpdates, updatePackageJson } from '@/utils/manifests'
import type { SaveStyle } from '@/utils/saveStyle'
import type { Pinning } from './adapter'

/**
 * Writes the moves past the range before the manager installs them (#230):
 * a row whose owning spec is `catalog:` / `catalog:<name>` moves that
 * catalog's entry, one catalog at a time, then every other row moves in the
 * manifest that owns it. pnpm's and bun's apply and `applyPinned` share it;
 * what follows the write (the install command, `-r` or `--filter *`) stays
 * in each adapter. Returns whether anything was written.
 */
export const writeBeyondRange = async (
  cwd: string,
  plans: ManifestPlan[],
  {
    style,
    writeCatalog,
    manager,
  }: {
    style: SaveStyle
    writeCatalog: Pinning['writeCatalog']
    /** The manager's name, for a catalog row with no catalog writer. */
    manager: string
  },
): Promise<boolean> => {
  const { catalogs, byManifest } = splitCatalogUpdates(cwd, plans)
  for (const [catalog, versions] of Object.entries(catalogs)) {
    if (!writeCatalog) {
      throw new StepError(
        'apply',
        `${manager} has no catalogs, but ${Object.keys(versions).join(', ')} read one`,
      )
    }
    await writeCatalog(cwd, versions, style, catalog)
  }
  for (const m of byManifest) {
    await updatePackageJson(path.join(cwd, m.path), m.versions, style)
  }
  return Object.keys(catalogs).length > 0 || byManifest.length > 0
}
