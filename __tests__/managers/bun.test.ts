import fs from 'fs'
import os from 'os'
import path from 'path'
import bun, {
  parseBunOutdated,
  parseBunWorkspaceOutdated,
} from '@/managers/bun'
import { workspaceOwner } from '@/managers/workspaces'
import { StepError } from '@/stepError'
import { readFixture, WORKSPACE_ENTRIES } from '../fixtures'

jest.mock('@/utils/logger')

describe('parseBunOutdated', () => {
  it('reads the table rows, with the Update column as wanted', () => {
    const result = parseBunOutdated(readFixture('bun/outdated-ranges.stdout'))

    expect(Object.keys(result)).toHaveLength(40)
    expect(Object.keys(result)).not.toContain('Package')
    expect(result.react).toEqual({
      name: 'react',
      current: '18.2.0',
      wanted: '18.3.1',
      latest: '19.3.1',
    })
  })

  it('reads empty output as nothing outdated', () => {
    expect(parseBunOutdated('')).toEqual({})
  })
})

describe('parseBunWorkspaceOutdated', () => {
  const named = workspaceOwner(
    [
      { path: '.', name: 'ws-root' },
      { path: 'packages/a', name: '@ws/a' },
      { path: 'packages/b', name: '@ws/b' },
    ],
    'bun',
  )

  it('parses one entry per table row, owners from the Workspace column', () => {
    const entries = parseBunWorkspaceOutdated(
      readFixture('bun/outdated-workspace.stdout'),
      named,
    )

    expect(entries).toHaveLength(5)
    expect(entries).toEqual(expect.arrayContaining(WORKSPACE_ENTRIES))
  })

  it('gives a catalog row to the workspace that uses the catalog', () => {
    // bun 1.4.0 prints `catalog (<workspace>)` and `catalog:<name> (<workspace>)`.
    const entries = parseBunWorkspaceOutdated(
      readFixture('bun/outdated-workspace-catalogs.stdout'),
      workspaceOwner(
        [
          { path: '.', name: 'autd-bun-catalogs' },
          { path: 'packages/a', name: '@autd/a' },
          { path: 'packages/b', name: '@autd/b' },
        ],
        'bun',
      ),
    )

    expect(
      entries.map((e) => [e.name, e.workspace, e.current, e.wanted]),
    ).toEqual([
      ['dayjs', '.', '1.11.9', '1.11.9'],
      ['ms', 'packages/a', '2.1.2', '2.1.2'],
      ['ms', '.', '2.1.1', '2.1.3'],
      ['chalk', 'packages/a', '4.0.0', '4.1.2'],
      ['commander', 'packages/b', '11.0.0', '11.1.0'],
      ['debug', 'packages/b', '4.3.1', '4.3.7'],
      ['uuid', 'packages/b', '9.0.0', '9.0.1'],
    ])
  })

  it('maps the empty Workspace cell of an unnamed root to the root', () => {
    const entries = parseBunWorkspaceOutdated(
      readFixture('bun/outdated-workspace-unnamed-root.stdout'),
      workspaceOwner(
        [
          { path: '.' },
          { path: 'packages/a', name: '@ws/a' },
          { path: 'packages/b', name: '@ws/b' },
        ],
        'bun',
      ),
    )

    expect(entries.map((e) => [e.name, e.workspace])).toEqual([
      ['dayjs', '.'],
      ['ms', 'packages/a'],
      ['dayjs', 'packages/b'],
      ['debug', 'packages/b'],
    ])
  })

  it('strips dependency markers and keeps only rows that are behind latest', () => {
    const output = [
      '| Package      | Current | Update | Latest | Workspace |',
      '|--------------|---------|--------|--------|-----------|',
      '| left (dev)   | 1.0.0   | 1.0.1  | 1.0.1  | ws-root   |',
      '| same         | 2.0.0   | 2.0.0  | 2.0.0  | ws-root   |',
    ].join('\n')

    expect(parseBunWorkspaceOutdated(output, named)).toEqual([
      {
        name: 'left',
        current: '1.0.0',
        wanted: '1.0.1',
        latest: '1.0.1',
        workspace: '.',
      },
    ])
  })

  it('fails discovery for a workspace no manifest declares', () => {
    expect(() =>
      parseBunWorkspaceOutdated(
        readFixture('bun/outdated-workspace.stdout'),
        workspaceOwner([{ path: '.', name: 'other' }], 'bun'),
      ),
    ).toThrow(StepError)
  })
})
