import type { UpdateResult } from '@/types'
import type { InstalledGraph } from '@/utils/installedGraph'

const versionOf = (id: string): string => id.slice(id.lastIndexOf('@') + 1)

/** How `keptInstalls` judges the edges it can't settle from the graph alone. */
export interface KeptRules {
  /** Whether `parent` (an id) declares `child` (a name) as a peer. */
  isPeer: (parent: string, child: string) => boolean
  /**
   * Whether a moving row's target still asks for `child` at `version`. Absent
   * (before the targets' manifests are read), a moving row keeps nothing.
   */
  keeps?: (row: UpdateResult, child: string, version: string) => boolean
}

/**
 * The installed packages (`name@version`) still installed once `rows` move:
 * every package a workspace depends on, unless the run moves it, and what
 * those depend on, transitively. A moving row's installed version is
 * replaced, so what it depended on stays only when its target still asks for
 * that version (`keeps`). A peer edge doesn't keep a package the run moves:
 * the peer resolves to the moved version. A workspace dependency without a
 * row (pnpm's auto-installed peers of a member, under the same catalog)
 * moves with a moving row of its name at that version.
 */
export const keptInstalls = (
  rows: readonly UpdateResult[],
  graph: InstalledGraph,
  { isPeer, keeps }: KeptRules,
): Set<string> => {
  const moving = rows.filter((r) => r.updated && r.target)
  const movingNames = new Set(moving.map((r) => r.name))
  const rowAt = new Map(
    rows.map((r) => [`${r.workspace ?? '.'}\0${r.name}`, r]),
  )

  const kept = new Set<string>()
  const queue: string[] = []
  const keep = (id: string) => {
    if (kept.has(id)) return
    kept.add(id)
    queue.push(id)
  }
  const follow = (parent: string, replacedBy?: UpdateResult) => {
    for (const { name, id } of graph.dependencies.get(parent) ?? []) {
      if (movingNames.has(name) && isPeer(parent, name)) continue
      if (replacedBy && !(keeps?.(replacedBy, name, versionOf(id)) ?? false))
        continue
      keep(id)
    }
  }

  const replaced = new Map<string, UpdateResult>()
  for (const [importer, dependencies] of graph.importers) {
    for (const [name, id] of dependencies) {
      const version = versionOf(id)
      const row = rowAt.get(`${importer}\0${name}`)
      const mover = row
        ? row.updated && row.target && row.current === version
          ? row
          : undefined
        : moving.find((r) => r.name === name && r.current === version)
      if (mover) replaced.set(id, mover)
      else keep(id)
    }
  }
  for (const [id, row] of replaced) follow(id, row)
  for (let id = queue.pop(); id !== undefined; id = queue.pop()) follow(id)
  return kept
}
