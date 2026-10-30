import fs from 'fs'
import path from 'path'

import {
  listsMember,
  matchesWorkspacePatterns,
  nearestManifestDir,
  pnpmWorkspacePatterns,
  toPosix,
} from '@/managers/workspaces'
import { readTextFile } from '@/utils/saveStyle'

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

const pnpmListsMember = (root: string, dir: string): boolean =>
  matchesWorkspacePatterns(
    pnpmWorkspacePatterns(readTextFile(path.join(root, 'pnpm-workspace.yaml'))),
    toPosix(path.relative(root, dir)),
  )

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
  for (let parent = path.dirname(dir); ; parent = path.dirname(parent)) {
    if (listsMember(parent, dir) || pnpmListsMember(parent, dir)) {
      return { dir, workspaceRoot: parent }
    }
    if (path.dirname(parent) === parent) return { dir, workspaceRoot: dir }
  }
}
