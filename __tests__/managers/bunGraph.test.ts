import path from 'path'
import { adapterFor } from '@/managers'
import { readBunGraph } from '@/managers/bun/graph'
import { readFixture } from '../fixtures'
import { tempDir, write } from '../fixtures/files'
import { tiptapGraphCases } from '../fixtures/installedGraph'

const LOCK = 'bun/tiptap-3.33.0.bun.lock.body'

describe('readBunGraph', () => {
  const project = (lock: string = readFixture(LOCK)): string => {
    const cwd = tempDir('autd-bun-graph-')
    write(path.join(cwd, 'bun.lock'), lock)
    return cwd
  }
  const graph = () => {
    const found = readBunGraph(project())
    if (!found) throw new Error(`${LOCK} was not read`)
    return found
  }

  describe('on the tiptap 3.33.0 workspace lockfile (bun 1.4.4, isolated or hoisted)', () => {
    tiptapGraphCases(graph, { peers: true })

    it('reads the root workspace, which declares nothing, as an empty importer', () => {
      expect(graph().importers.get('.')).toEqual(new Map())
    })

    it('reads a lockfile with Windows line endings the same', () => {
      expect(
        readBunGraph(project(readFixture(LOCK).replaceAll('\n', '\r\n'))),
      ).toEqual(graph())
    })
  })

  describe('on a workspace with nested copies (bun 1.4.4, 2026-11-12)', () => {
    // root: debug 4.3.4, ms 2.1.3; @nested/a: ms 2.1.2; b: debug 4.3.7.
    const read = () => {
      const found = readBunGraph(
        project(readFixture('bun/nested-copies.bun.lock.body')),
      )
      if (!found) throw new Error('nested-copies.bun.lock.body was not read')
      return found
    }

    it("resolves a workspace's dependency to its own copy, keyed by the workspace's name", () => {
      const { importers } = read()

      expect(importers.get('packages/a')?.get('ms')).toBe('ms@2.1.2')
      expect(importers.get('packages/b')?.get('debug')).toBe('debug@4.3.7')
      expect(importers.get('.')?.get('ms')).toBe('ms@2.1.3')
      expect(importers.get('.')?.get('debug')).toBe('debug@4.3.4')
    })

    it('resolves a package dependency to the copy nested under it before the hoisted one', () => {
      const { dependencies } = read()

      expect(dependencies.get('debug@4.3.4')).toEqual([
        { name: 'ms', id: 'ms@2.1.2' },
      ])
    })

    it("walks up from a workspace's own copy to the hoisted one", () => {
      // `b/debug` depends on ms ^2.1.3: no `b/debug/ms`, no `b/ms`, then `ms`.
      expect(read().dependencies.get('debug@4.3.7')).toEqual([
        { name: 'ms', id: 'ms@2.1.3' },
      ])
    })

    it('has every copy as a node, a workspace package as none, and an uninstalled optional peer as no edge', () => {
      const { dependencies } = read()

      expect([...dependencies.keys()].sort()).toEqual([
        'debug@4.3.4',
        'debug@4.3.7',
        'ms@2.1.2',
        'ms@2.1.3',
      ])
    })

    it('skips a workspace dependency', () => {
      expect(read().importers.get('packages/a')?.has('b')).toBe(false)
    })
  })

  describe('trailing commas', () => {
    // Derived from the capture: the lockfile's own text with a comma kept
    // where a string holds one, and one after the last member of an object.
    const derived = (edit: (text: string) => string) => {
      const found = readBunGraph(project(edit(readFixture(LOCK))))
      if (!found) throw new Error('the derived lockfile was not read')
      return found
    }

    it('are dropped only before a closing brace or bracket, outside strings', () => {
      expect(
        derived((text) =>
          text.replace(
            '"@tiptap/pm": ["@tiptap/pm@3.33.0"',
            '"@tiptap/pm": ["@tiptap/pm@3.33.0,}"',
          ),
        ).dependencies.has('@tiptap/pm@3.33.0,}'),
      ).toBe(true)
    })

    it('are not needed: a lockfile without any reads the same', () => {
      expect(derived((text) => text.replace(/,(\s*[}\]])/g, '$1'))).toEqual(
        graph(),
      )
    })
  })

  describe('as the bun adapter reads it', () => {
    it('answers installedGraph the same', () => {
      expect(adapterFor('bun').installedGraph?.(project())).toEqual(graph())
    })
  })

  it('is undefined without a bun.lock', () => {
    expect(readBunGraph(tempDir('autd-bun-graph-'))).toBeUndefined()
  })

  it('is undefined for the binary bun.lockb', () => {
    const cwd = tempDir('autd-bun-graph-')
    write(path.join(cwd, 'bun.lockb'), '#!bun do not edit\0\0')

    expect(readBunGraph(cwd)).toBeUndefined()
  })

  it('is undefined for a truncated lockfile', () => {
    const lock = readFixture(LOCK)

    expect(
      readBunGraph(project(lock.slice(0, lock.length / 2))),
    ).toBeUndefined()
  })
})
