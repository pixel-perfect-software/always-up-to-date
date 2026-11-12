import path from 'path'
import { readInstalledGraph } from '@/utils/installedGraph'
import { readFixture } from '../fixtures'
import { tempDir, write } from '../fixtures/files'

describe('readInstalledGraph', () => {
  const installed = (fixture: string) => {
    const cwd = tempDir('autd-graph-')
    write(
      path.join(cwd, 'node_modules', '.pnpm', 'lock.yaml'),
      readFixture(fixture),
    )
    const graph = readInstalledGraph(cwd)
    if (!graph) throw new Error(`${fixture} was not read`)
    return graph
  }

  describe('on the tiptap 3.33.0 install', () => {
    const graph = () => installed('pnpm/tiptap-3.33.0.lock.body')

    it("drops the peer suffix from a workspace's dependency ids", () => {
      expect(
        graph().importers.get('packages/editor')?.get('@tiptap/core'),
      ).toBe('@tiptap/core@3.33.0')
    })

    it('skips a workspace link, which pnpm does not install', () => {
      expect(graph().importers.get('apps/tenantsee')?.has('@repo/editor')).toBe(
        false,
      )
    })

    it('reads a workspace with no dependencies as an empty map', () => {
      expect(graph().importers.get('.')).toEqual(new Map())
    })

    it('lists an optional dependency of a package', () => {
      expect(graph().dependencies.get('@tiptap/react@3.33.0')).toContainEqual({
        name: '@tiptap/extension-bubble-menu',
        id: '@tiptap/extension-bubble-menu@3.33.0',
      })
    })

    it('lists the peers a package resolved, with their suffix dropped', () => {
      expect(graph().dependencies.get('@tiptap/react@3.33.0')).toContainEqual({
        name: '@tiptap/core',
        id: '@tiptap/core@3.33.0',
      })
    })
  })

  describe('on the partially updated install', () => {
    const graph = () => installed('pnpm/tiptap-partial-update.lock.body')

    it('has both versions of a package as nodes', () => {
      const { dependencies } = graph()

      expect(dependencies.has('@tiptap/core@3.33.0')).toBe(true)
      expect(dependencies.has('@tiptap/core@3.33.1')).toBe(true)
    })

    it('merges the peer variants of an entry into one node, each dependency once', () => {
      // extension-list@3.33.1 is installed against core 3.33.0 and 3.33.1.
      const list = graph().dependencies.get('@tiptap/extension-list@3.33.1')

      expect(list).toContainEqual({
        name: '@tiptap/core',
        id: '@tiptap/core@3.33.0',
      })
      expect(list).toContainEqual({
        name: '@tiptap/core',
        id: '@tiptap/core@3.33.1',
      })
      expect(new Set(list?.map((d) => `${d.name}\0${d.id}`)).size).toBe(
        list?.length,
      )
    })
  })

  it('is undefined without an installed lockfile', () => {
    expect(readInstalledGraph(tempDir('autd-graph-'))).toBeUndefined()
  })
})
