import path from 'path'
import { adapterFor } from '@/managers'
import { readNpmGraph } from '@/managers/npm/graph'
import { readFixture } from '../fixtures'
import { tempDir, write } from '../fixtures/files'
import { tiptapGraphCases } from '../fixtures/installedGraph'

const LOCK = 'npm/tiptap-3.33.0.package-lock.body'

describe('readNpmGraph', () => {
  const project = (lock: string = readFixture(LOCK)): string => {
    const cwd = tempDir('autd-npm-graph-')
    write(path.join(cwd, 'package-lock.json'), lock)
    return cwd
  }
  const graph = () => {
    const found = readNpmGraph(project())
    if (!found) throw new Error(`${LOCK} was not read`)
    return found
  }

  describe('on the tiptap 3.33.0 workspace lockfile (npm 11.19.1)', () => {
    tiptapGraphCases(graph, { peers: true })

    it('reads the root workspace, which declares nothing, as an empty importer', () => {
      expect(graph().importers.get('.')).toEqual(new Map())
    })

    it('reads the same graph with a node_modules next to the lockfile', () => {
      const cwd = project()
      write(path.join(cwd, 'node_modules', '.package-lock.json'), '{}')

      expect(readNpmGraph(cwd)).toEqual(graph())
    })
  })

  describe('on the earlier captures (#107, #198)', () => {
    const read = (name: string) => {
      const found = readNpmGraph(project(readFixture(`npm/${name}`)))
      if (!found) throw new Error(`${name} was not read`)
      return found
    }

    it("resolves a dependency to the nearest copy: debug's own nested ms, not the root's", () => {
      const { importers, dependencies } = read(
        'no-node-modules.package-lock.json',
      )

      expect(dependencies.get('debug@4.3.1')).toEqual([
        { name: 'ms', id: 'ms@2.1.2' },
      ])
      expect(importers.get('.')?.get('ms')).toBe('ms@2.1.1')
      expect(dependencies.has('ms@2.1.1')).toBe(true)
      expect(dependencies.has('ms@2.1.2')).toBe(true)
    })

    it("resolves a member's dependency to its own nested copy, then to the root's", () => {
      const { importers } = read('workspace-no-node-modules.package-lock.json')

      expect(importers.get('packages/a')?.get('ms')).toBe('ms@2.1.2')
      expect(importers.get('packages/a')?.get('chalk')).toBe('chalk@4.1.2')
      expect(importers.get('packages/b')?.get('debug')).toBe('debug@4.3.7')
      expect(importers.get('.')?.get('ms')).toBe('ms@2.1.3')
    })

    it('never makes a workspace link a node or an edge', () => {
      const { importers, dependencies } = read(
        'workspace-no-node-modules.package-lock.json',
      )

      expect([...importers.keys()].sort()).toEqual([
        '.',
        'packages/a',
        'packages/b',
      ])
      expect(
        [...dependencies.keys()].some((id) => id.startsWith('@autd/')),
      ).toBe(false)
    })

    it('resolves a peer to the copy installed, and an uninstalled optional peer to none', () => {
      const { dependencies } = read('peers-no-node-modules.package-lock.json')
      const redux = dependencies.get('react-redux@8.1.3')

      expect(redux).toContainEqual({ name: 'react', id: 'react@17.0.2' })
      expect(redux).toContainEqual({
        name: '@types/react',
        id: '@types/react@18.3.31',
      })
      expect(redux?.some((edge) => edge.name === 'react-dom')).toBe(false)
    })

    it("keeps two copies of one name apart: react-redux's react-is is not hoist-non-react-statics's", () => {
      const { dependencies } = read('peers-no-node-modules.package-lock.json')

      expect(dependencies.get('react-redux@8.1.3')).toContainEqual({
        name: 'react-is',
        id: 'react-is@18.3.1',
      })
      expect(dependencies.get('hoist-non-react-statics@3.3.2')).toEqual([
        { name: 'react-is', id: 'react-is@16.13.1' },
      ])
    })
  })

  describe('as the npm adapter reads it', () => {
    it('answers installedGraph the same, with or without node_modules', () => {
      expect(adapterFor('npm').installedGraph?.(project())).toEqual(graph())
    })
  })

  it('is undefined without a package-lock.json', () => {
    expect(readNpmGraph(tempDir('autd-npm-graph-'))).toBeUndefined()
  })

  it('is undefined for a truncated lockfile', () => {
    const lock = readFixture(LOCK)

    expect(
      readNpmGraph(project(lock.slice(0, lock.length / 2))),
    ).toBeUndefined()
  })

  it('is undefined for a lockfile with no packages (lockfileVersion 1)', () => {
    expect(
      readNpmGraph(
        project(JSON.stringify({ lockfileVersion: 1, dependencies: {} })),
      ),
    ).toBeUndefined()
  })
})
