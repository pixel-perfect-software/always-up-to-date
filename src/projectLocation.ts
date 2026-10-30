import fs from 'fs'
import path from 'path'

import {
  listsMember,
  nearestManifestDir,
  pnpmWorkspaceRoot,
} from '@/managers/workspaces'

export interface Location {
  /** The nearest directory at or above the command's cwd with a package.json; the cwd when none has one. */
  dir: string
  /**
   * The nearest ancestor of `dir` listing it (package.json `workspaces`,
   * pnpm-workspace.yaml `packages`); `dir` when none does or `dir` has its
   * own pnpm-workspace.yaml.
   */
  workspaceRoot: string
}

/**
 * Where a run from `cwd` belongs, before a manager is known (#123): the
 * member's directory and the workspace root that lists it, whichever file
 * lists it. Detection and the config start here; `adapter.projectRoot` has
 * the final word afterwards.
 */
export const locate = (cwd: string): Location => {
  const dir = nearestManifestDir(cwd)
  if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) {
    return { dir, workspaceRoot: dir }
  }
  // pnpm reads only the nearest pnpm-workspace.yaml, as `pnpmWorkspaceRoot`
  // does: one that does not list `dir` is not walked past.
  const pnpmRoot = pnpmWorkspaceRoot(dir)
  for (let parent = path.dirname(dir); ; parent = path.dirname(parent)) {
    if (listsMember(parent, dir) || parent === pnpmRoot) {
      return { dir, workspaceRoot: parent }
    }
    if (path.dirname(parent) === parent) return { dir, workspaceRoot: dir }
  }
}
