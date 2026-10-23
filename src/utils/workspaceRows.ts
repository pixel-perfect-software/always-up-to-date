import type { OutdatedEntry, PackageInfo, WorkspaceVersion } from '@/types'

const byPath = (a: WorkspaceVersion, b: WorkspaceVersion): number => {
  if (a.path === b.path) return 0
  if (a.path === '.') return -1
  if (b.path === '.') return 1
  return a.path < b.path ? -1 : 1
}

/**
 * Groups a workspace project's entries by package name, in the order each
 * name first appears. Every value lists its manifests (root first, then by
 * path); `current` and `wanted` repeat the root's, else the first member's.
 */
export const foldWorkspaceEntries = (
  entries: OutdatedEntry[],
): Record<string, PackageInfo> => {
  const grouped = new Map<string, OutdatedEntry[]>()
  for (const entry of entries) {
    const rows = grouped.get(entry.name)
    if (rows) rows.push(entry)
    else grouped.set(entry.name, [entry])
  }

  const folded: Record<string, PackageInfo> = {}
  for (const [name, rows] of grouped) {
    const workspaces = rows
      .map(({ workspace, current, wanted }) => ({
        path: workspace,
        current,
        wanted,
      }))
      .sort(byPath)
    folded[name] = {
      name,
      current: workspaces[0].current,
      wanted: workspaces[0].wanted,
      latest: rows[0].latest,
      workspaces,
    }
  }
  return folded
}

/** A manifest's label in human output: `(root)`, or its path. */
export const workspaceLabel = (workspacePath: string): string =>
  workspacePath === '.' ? '(root)' : workspacePath
