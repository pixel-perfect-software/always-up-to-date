import type { InstalledGraph } from '@/utils/installedGraph'

/**
 * The checks every lockfile reader shares on its capture of the tiptap 3.33.0
 * workspace (`apps/tenantsee` depending on `@repo/editor`, which declares
 * tiptap as peers; npm 11.19.1, yarn 1.22.22, yarn 4.18.1 and bun 1.4.4, one
 * install each, 2026-11-12). `peers` is whether the manager installs the
 * peers it resolves: npm and bun do, both yarns do not.
 */
export const tiptapGraphCases = (
  graph: () => InstalledGraph,
  { peers }: { peers: boolean },
): void => {
  const blockquote = '@tiptap/extension-blockquote@3.33.0'

  it("maps a member's direct dependencies to their installed ids", () => {
    const tenantsee = graph().importers.get('apps/tenantsee')

    expect(tenantsee?.get('@tiptap/core')).toBe('@tiptap/core@3.33.0')
    expect(tenantsee?.get('@tiptap/react')).toBe('@tiptap/react@3.33.0')
  })

  it('skips a dependency on a workspace package, which is never a node', () => {
    const { importers, dependencies } = graph()

    expect(importers.get('apps/tenantsee')?.has('@repo/editor')).toBe(false)
    expect([...dependencies.keys()].some((id) => id.startsWith('@repo/'))).toBe(
      false,
    )
  })

  it('has the root and every member as an importer, by posix path', () => {
    expect([...graph().importers.keys()].sort()).toEqual([
      '.',
      'apps/tenantsee',
      'packages/editor',
    ])
  })

  it('lists a dependency of a package', () => {
    expect(
      graph().dependencies.get('@tiptap/starter-kit@3.33.0'),
    ).toContainEqual({
      name: '@tiptap/extension-blockquote',
      id: blockquote,
    })
  })

  it('lists an optional dependency of a package', () => {
    expect(graph().dependencies.get('@tiptap/react@3.33.0')).toContainEqual({
      name: '@tiptap/extension-bubble-menu',
      id: '@tiptap/extension-bubble-menu@3.33.0',
    })
  })

  it('has a package with nothing to depend on as a node with no edges', () => {
    expect(graph().dependencies.get('@tiptap/pm@3.33.0')).toBeDefined()
    expect(graph().dependencies.get('@floating-ui/utils@0.2.12')).toEqual([])
  })

  it('lists each edge of a package once', () => {
    for (const edges of graph().dependencies.values()) {
      expect(new Set(edges.map((e) => `${e.name}\0${e.id}`)).size).toBe(
        edges.length,
      )
    }
  })

  it(
    peers
      ? 'lists the peer a package resolved as an edge'
      : 'lists no peer edge, as the manager records no resolved peer',
    () => {
      const edges = graph().dependencies.get(blockquote)

      if (peers) {
        expect(edges).toContainEqual({
          name: '@tiptap/core',
          id: '@tiptap/core@3.33.0',
        })
      } else {
        expect(edges?.some((edge) => edge.name === '@tiptap/core')).toBe(false)
      }
    },
  )

  it(
    peers
      ? "resolves a member's own peers as its direct dependencies"
      : "does not resolve a member's own peers",
    () => {
      const editor = graph().importers.get('packages/editor')

      expect(editor?.get('@tiptap/core')).toBe(
        peers ? '@tiptap/core@3.33.0' : undefined,
      )
    },
  )
}
