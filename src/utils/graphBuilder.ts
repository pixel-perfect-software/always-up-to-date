import type { InstalledGraph } from '@/utils/installedGraph'

/**
 * Builds an `InstalledGraph` for a lockfile reader: every id is a node, an
 * edge is kept once per (node, name, id), and an importer is a map of its
 * direct dependencies, so the readers only say what they found.
 */
export const graphBuilder = (): {
  /** The workspace at `path` (`.` the root), created empty on first use. */
  importer: (path: string) => Map<string, string>
  /** `id` is installed; it may depend on nothing. */
  node: (id: string) => void
  /** `from` depends on `name`, which resolved to `id` (also a node). */
  edge: (from: string, name: string, id: string) => void
  graph: () => InstalledGraph
} => {
  const importers = new Map<string, Map<string, string>>()
  const dependencies = new Map<string, { name: string; id: string }[]>()
  const seen = new Set<string>()

  const node = (id: string): { name: string; id: string }[] => {
    const edges = dependencies.get(id) ?? []
    dependencies.set(id, edges)
    return edges
  }

  return {
    importer: (path) => {
      const found = importers.get(path) ?? new Map<string, string>()
      importers.set(path, found)
      return found
    },
    node: (id) => {
      node(id)
    },
    edge: (from, name, id) => {
      const edges = node(from)
      node(id)
      const key = `${from}\0${name}\0${id}`
      if (seen.has(key)) return
      seen.add(key)
      edges.push({ name, id })
    },
    graph: () => ({ importers, dependencies }),
  }
}
