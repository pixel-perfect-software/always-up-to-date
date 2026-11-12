import path from 'path'
import { adapterFor } from '@/managers'
import { readBerryGraph, readYarnV1Graph } from '@/managers/yarn/graph'
import { readFixture } from '../fixtures'
import { tempDir, write } from '../fixtures/files'
import { tiptapGraphCases } from '../fixtures/installedGraph'

const TIPTAP = [
  '@tiptap/core',
  '@tiptap/extension-placeholder',
  '@tiptap/extension-table',
  '@tiptap/extension-task-item',
  '@tiptap/extension-task-list',
  '@tiptap/extension-text-align',
  '@tiptap/pm',
  '@tiptap/react',
  '@tiptap/starter-kit',
]

/**
 * The workspace both yarn captures were installed from (yarn 1.22.22 and 4.18.1,
 * 2026-11-12): the member's dependency on `@repo/editor` is `*` for v1 and
 * `workspace:*` for berry.
 */
const workspace = (cwd: string, packageManager: string, editor: string) => {
  write(path.join(cwd, 'package.json'), {
    name: 'repro-root',
    private: true,
    packageManager,
    workspaces: ['apps/*', 'packages/*'],
  })
  write(path.join(cwd, 'apps/tenantsee/package.json'), {
    name: 'tenantsee',
    version: '0.0.0',
    private: true,
    dependencies: {
      '@repo/editor': editor,
      ...Object.fromEntries(TIPTAP.map((name) => [name, '3.33.0'])),
      react: '19.3.1',
      'react-dom': '19.3.1',
    },
  })
  write(path.join(cwd, 'packages/editor/package.json'), {
    name: '@repo/editor',
    version: '0.0.0',
    private: true,
    peerDependencies: {
      '@tiptap/core': '^3.33.0',
      '@tiptap/extension-table': '^3.33.0',
      '@tiptap/extension-task-list': '^3.33.0',
      '@tiptap/extension-text-align': '^3.33.0',
      '@tiptap/pm': '^3.33.0',
      '@tiptap/react': '^3.33.0',
      '@tiptap/starter-kit': '^3.33.0',
      react: '^19.3.1',
      'react-dom': '^19.3.1',
    },
    peerDependenciesMeta: {
      '@tiptap/extension-table': { optional: true },
      '@tiptap/extension-task-list': { optional: true },
      '@tiptap/extension-text-align': { optional: true },
      '@tiptap/starter-kit': { optional: true },
    },
  })
}

const V1 = 'yarn/tiptap-3.33.0.yarn-v1.lock.body'
const BERRY = 'yarn/tiptap-3.33.0.berry.lock.body'

describe('readYarnV1Graph', () => {
  const project = (lock: string = readFixture(V1)): string => {
    const cwd = tempDir('autd-yarn-graph-')
    workspace(cwd, 'yarn@1.22.22', '*')
    write(path.join(cwd, 'yarn.lock'), lock)
    return cwd
  }
  const graph = () => {
    const found = readYarnV1Graph(project())
    if (!found) throw new Error(`${V1} was not read`)
    return found
  }

  describe('on the tiptap 3.33.0 workspace lockfile (yarn 1.22.22)', () => {
    // v1 installs no peers, and its lockfile records none.
    tiptapGraphCases(graph, { peers: false })

    it("takes a workspace's dependencies from its package.json, by descriptor", () => {
      expect(graph().importers.get('apps/tenantsee')?.get('react-dom')).toBe(
        'react-dom@19.3.1',
      )
    })

    it('reads the root workspace, which declares nothing, as an empty importer', () => {
      expect(graph().importers.get('.')).toEqual(new Map())
    })

    it('joins the descriptors of an entry to one node', () => {
      // prosemirror-model is asked for as ^1.0.0, ^1.21.0, ^1.25.12 and ^1.25.4.
      const edges = graph().dependencies.get('prosemirror-tables@1.8.5')

      expect(edges).toContainEqual({
        name: 'prosemirror-model',
        id: 'prosemirror-model@1.25.13',
      })
    })
  })

  describe('as the yarn adapter reads it', () => {
    it('answers installedGraph with v1 reading for a v1 project', () => {
      expect(adapterFor('yarn').installedGraph?.(project())).toEqual(graph())
    })
  })

  it('is undefined without a yarn.lock', () => {
    const cwd = tempDir('autd-yarn-graph-')
    workspace(cwd, 'yarn@1.22.22', '*')

    expect(readYarnV1Graph(cwd)).toBeUndefined()
  })

  it('is undefined for a file that is not a v1 lockfile', () => {
    expect(readYarnV1Graph(project(readFixture(BERRY)))).toBeUndefined()
  })

  it('is undefined when yarn.lock cannot be read', () => {
    const cwd = tempDir('autd-yarn-graph-')
    workspace(cwd, 'yarn@1.22.22', '*')
    write(path.join(cwd, 'yarn.lock', 'not-a-file'), '')

    expect(readYarnV1Graph(cwd)).toBeUndefined()
  })

  it('reads the entries a truncated lockfile still holds', () => {
    const lock = readFixture(V1)
    const found = readYarnV1Graph(project(lock.slice(0, lock.length / 2)))

    expect(found?.dependencies.has('@tiptap/core@3.33.0')).toBe(true)
    expect(found?.dependencies.has('scheduler@0.28.0')).toBe(false)
  })
})

describe('readBerryGraph', () => {
  const project = (lock: string = readFixture(BERRY)): string => {
    const cwd = tempDir('autd-berry-graph-')
    workspace(cwd, 'yarn@4.18.1', 'workspace:*')
    write(path.join(cwd, 'yarn.lock'), lock)
    return cwd
  }
  const graph = () => {
    const found = readBerryGraph(project())
    if (!found) throw new Error(`${BERRY} was not read`)
    return found
  }

  describe('on the tiptap 3.33.0 workspace lockfile (yarn 4.18.1, PnP or node_modules)', () => {
    // berry records no resolved peers: `peerDependencies` holds ranges.
    tiptapGraphCases(graph, { peers: false })

    it("takes a workspace's dependencies from its own lockfile entry", () => {
      expect(graph().importers.get('apps/tenantsee')?.get('react-dom')).toBe(
        'react-dom@19.3.1',
      )
    })

    it('reads the root workspace, which declares nothing, as an empty importer', () => {
      expect(graph().importers.get('.')).toEqual(new Map())
    })

    it('reads the lockfile alone: no package.json is needed', () => {
      const cwd = tempDir('autd-berry-graph-')
      write(path.join(cwd, 'yarn.lock'), readFixture(BERRY))

      expect(readBerryGraph(cwd)).toEqual(graph())
    })
  })

  describe('on the testRepos/berry-workspace lockfile (yarn 4.18.1, #107)', () => {
    const read = () => {
      const cwd = tempDir('autd-berry-graph-')
      write(
        path.join(cwd, 'yarn.lock'),
        readFixture('yarn/berry-workspace.yarn.lock'),
      )
      const found = readBerryGraph(cwd)
      if (!found) throw new Error('berry-workspace.yarn.lock was not read')
      return found
    }

    it('does not make a builtin patch a node, and keeps the npm entry it patches', () => {
      const ids = [...read().dependencies.keys()]

      expect(ids.some((id) => id.includes('patch:'))).toBe(false)
      expect(ids).toContain('resolve@1.22.13')
    })

    it("names an alias's node by its target, keeping the dependency's key as the edge", () => {
      const { importers, dependencies } = read()

      expect(importers.get('packages/b')?.get('m')).toBe('ms@2.1.3')
      expect([...dependencies.keys()].some((id) => id.startsWith('m@'))).toBe(
        false,
      )
    })

    it('skips a workspace dependency and keys the importers by the workspace path', () => {
      const { importers } = read()

      expect([...importers.keys()].sort()).toEqual([
        '.',
        'packages/a',
        'packages/b',
      ])
      expect(importers.get('packages/b')?.has('@autd/a')).toBe(false)
      expect(importers.get('packages/b')?.get('debug')).toBe('debug@4.3.7')
      expect(importers.get('packages/a')?.get('ms')).toBe('ms@2.1.2')
      expect(importers.get('.')?.get('ms')).toBe('ms@2.1.3')
    })
  })

  describe('as the yarn adapter reads it', () => {
    it('answers installedGraph with berry reading for a berry project', () => {
      expect(adapterFor('yarn').installedGraph?.(project())).toEqual(graph())
    })
  })

  it('is undefined without a yarn.lock', () => {
    expect(readBerryGraph(tempDir('autd-berry-graph-'))).toBeUndefined()
  })

  it('is undefined for a file that is not a berry lockfile', () => {
    expect(readBerryGraph(project(readFixture(V1)))).toBeUndefined()
  })

  it('is undefined for a lockfile cut before its metadata', () => {
    const lock = readFixture(BERRY)

    expect(
      readBerryGraph(project(lock.slice(0, lock.indexOf('__metadata')))),
    ).toBeUndefined()
  })
})
