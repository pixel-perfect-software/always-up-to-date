import fs from 'fs'
import os from 'os'
import path from 'path'
import bun, {
  parseBunOutdated,
  parseBunWorkspaceOutdated,
} from '@/managers/bun'
import { workspaceOwner } from '@/managers/workspaces'
import { check } from '@/pipeline'
import { StepError } from '@/stepError'
import {
  exitError,
  projectFor,
  readFixture,
  WORKSPACE_ENTRIES,
} from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils/registry', () => ({
  clearRegistryCache: jest.fn(),
  fetchReleaseTimes: jest.fn(),
}))
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { runProcess } from '@/utils'

const mockedRunProcess = jest.mocked(runProcess)

describe('check with bun', () => {
  it('carries wanted from the Update column', async () => {
    mockedRunProcess.mockResolvedValue({
      stdout: readFixture('bun/outdated-ranges.stdout'),
      stderr: '',
    })

    const result = await check(projectFor(bun, '/project'))

    expect(result.react).toMatchObject({
      current: '18.2.0',
      wanted: '18.3.1',
      latest: '19.3.1',
    })
    expect(result.minimist).toMatchObject({ current: '1.2.7', wanted: '1.2.7' })
  })

  it('lists outdated packages when bun exits 0 with its table', async () => {
    mockedRunProcess.mockResolvedValue({
      stdout: readFixture('bun/outdated.stdout'),
      stderr: '',
    })

    const result = await check(projectFor(bun, '/project'))

    expect(Object.keys(result)).toHaveLength(40)
    expect(result.dayjs).toEqual({
      name: 'dayjs',
      current: '1.11.9',
      wanted: '1.11.9',
      latest: '1.11.23',
    })
  })

  it('fails when bun exits 1, even though it printed part of a report', async () => {
    mockedRunProcess.mockRejectedValue(
      exitError(
        1,
        readFixture('bun/outdated-error.stdout'),
        readFixture('bun/outdated-error.stderr'),
      ),
    )

    await expect(check(projectFor(bun, '/project'))).rejects.toThrow(
      /ConnectionRefused/,
    )
  })

  it('passes the workspace filter as a bare * argument', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-bun-'))
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ workspaces: ['packages/*'] }),
    )
    mockedRunProcess.mockResolvedValue({ stdout: '', stderr: '' })

    try {
      await check(projectFor(bun, cwd))
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }

    // Before argument arrays this was the shell string `--filter '*'`.
    expect(mockedRunProcess).toHaveBeenCalledWith(
      'bun',
      ['outdated', '--filter', '*'],
      { cwd },
    )
  })
})

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
