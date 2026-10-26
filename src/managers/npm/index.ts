import fs from 'fs'
import path from 'path'

import type { ManagerAdapter } from '@/managers/adapter'
import { packageJsonWorkspace } from '@/managers/workspaces'
import { updatePackageJson } from '@/utils/files'
import { loadNpmrc, npmrcBoolean } from '@/utils/npmrcLoader'
import { manifestOverrides } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE } from '@/utils/saveStyle'

/**
 * Versions package-lock.json records, keyed by install path
 * (`node_modules/ms`). Empty when there is no readable lockfile.
 */
export const readLockedVersions = (cwd: string): Record<string, string> => {
  let packages: Record<string, { version?: unknown }>
  try {
    packages =
      JSON.parse(fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'))
        .packages ?? {}
  } catch {
    return {}
  }
  const versions: Record<string, string> = {}
  for (const [location, entry] of Object.entries(packages)) {
    if (typeof entry?.version === 'string') versions[location] = entry.version
  }
  return versions
}

const npm: ManagerAdapter = {
  name: 'npm',
  lockfile: 'package-lock.json',

  readWorkspace: (cwd) => ({
    ...packageJsonWorkspace(cwd),
    catalogs: {},
  }),

  apply: async (run, cwd, { names, manifests }) => {
    // npm installs the highest version each range allows. Only packages
    // moving past their range need their manifest spec rewritten first, in
    // the manifest that owns it.
    const style = npm.saveStyle(cwd)
    const written = manifests.filter(
      (m) => Object.keys(m.beyondRange).length > 0,
    )
    for (const m of written) {
      await updatePackageJson(path.join(cwd, m.path), m.beyondRange, style)
    }

    // `npm update` at the root moves every workspace's ranges too;
    // `--workspaces` would skip the root's own.
    await run(['update', ...names], { manifestWritten: written.length > 0 })
  },

  /** `save-exact` / `save-prefix` in .npmrc. */
  saveStyle: (cwd) => {
    const npmrc = loadNpmrc(cwd)
    const prefix = npmrc['save-prefix']
    return {
      exact: npmrcBoolean(npmrc['save-exact']) ?? false,
      prefix: typeof prefix === 'string' ? prefix : DEFAULT_SAVE_STYLE.prefix,
    }
  },

  overrides: (cwd) => manifestOverrides(cwd, ['overrides']),
}

export default npm
