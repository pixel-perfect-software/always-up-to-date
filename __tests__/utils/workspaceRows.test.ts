import type { OutdatedEntry } from '@/types'
import {
  expandWorkspaces,
  foldWorkspaceEntries,
  workspaceLabel,
} from '@/utils/workspaceRows'
import { WORKSPACE_ENTRIES } from '../fixtures'

const entry = (
  name: string,
  workspace: string,
  current = '1.0.0',
  wanted = '1.0.1',
): OutdatedEntry => ({ name, workspace, current, wanted, latest: '2.0.0' })

describe('foldWorkspaceEntries', () => {
  it('groups by name in first-appearance order, root first, then by path', () => {
    const folded = foldWorkspaceEntries([
      entry('b-pkg', 'packages/z'),
      entry('a-pkg', 'packages/b'),
      entry('b-pkg', '.'),
      entry('a-pkg', 'packages/a'),
    ])

    expect(Object.keys(folded)).toEqual(['b-pkg', 'a-pkg'])
    expect(folded['b-pkg'].workspaces?.map((w) => w.path)).toEqual([
      '.',
      'packages/z',
    ])
    expect(folded['a-pkg'].workspaces?.map((w) => w.path)).toEqual([
      'packages/a',
      'packages/b',
    ])
  })

  it("takes the top-level versions from the root's row, else the first member's", () => {
    const folded = foldWorkspaceEntries([
      entry('both', 'packages/a', '1.0.0', '1.0.1'),
      entry('both', '.', '1.1.0', '1.1.5'),
      entry('members', 'packages/b', '3.0.0', '3.0.3'),
      entry('members', 'packages/a', '2.0.0', '2.0.2'),
    ])

    expect(folded.both).toMatchObject({ current: '1.1.0', wanted: '1.1.5' })
    expect(folded.members).toMatchObject({ current: '2.0.0', wanted: '2.0.2' })
  })

  it('keeps workspaces even for a single manifest, in the agreed key order', () => {
    const folded = foldWorkspaceEntries([entry('only', 'packages/a')])

    expect(Object.keys(folded.only)).toEqual([
      'name',
      'current',
      'wanted',
      'latest',
      'workspaces',
    ])
    expect(folded.only.workspaces).toEqual([
      { path: 'packages/a', current: '1.0.0', wanted: '1.0.1' },
    ])
  })

  it('folds the evidence workspace the way every manager reports it', () => {
    const folded = foldWorkspaceEntries(WORKSPACE_ENTRIES)

    expect(folded.dayjs).toEqual({
      name: 'dayjs',
      current: '1.11.9',
      wanted: '1.11.9',
      latest: '1.11.23',
      workspaces: [
        { path: '.', current: '1.11.9', wanted: '1.11.9' },
        { path: 'packages/b', current: '1.11.9', wanted: '1.11.23' },
      ],
    })
    expect(folded.debug).toMatchObject({ current: '4.3.1', wanted: '4.3.7' })
    expect(folded.ms).toMatchObject({ current: '2.1.1', wanted: '2.1.3' })
  })
})

describe('workspaceLabel', () => {
  it('labels the root and shows a member by its path', () => {
    expect(workspaceLabel('.')).toBe('(root)')
    expect(workspaceLabel('packages/a')).toBe('packages/a')
  })
})

describe('expandWorkspaces', () => {
  it('gives back the entries foldWorkspaceEntries grouped', () => {
    const expanded = expandWorkspaces(foldWorkspaceEntries(WORKSPACE_ENTRIES))

    const asEntries = expanded.map(({ name, workspace, info }) => ({
      name,
      workspace,
      current: info.current,
      wanted: info.wanted,
      latest: info.latest,
    }))
    expect(asEntries).toHaveLength(WORKSPACE_ENTRIES.length)
    expect(asEntries).toEqual(expect.arrayContaining(WORKSPACE_ENTRIES))
  })

  it('gives a single-package value as the one row, without a workspace', () => {
    const info = {
      name: 'ms',
      current: '1.0.0',
      wanted: '1.0.1',
      latest: '2.0.0',
    }

    expect(expandWorkspaces({ ms: info })).toEqual([{ name: 'ms', info }])
  })
})
