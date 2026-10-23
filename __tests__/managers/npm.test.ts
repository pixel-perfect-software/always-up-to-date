import fs from 'fs'
import os from 'os'
import path from 'path'
import npm, {
  parseNpmOutdated,
  parseNpmWorkspaceOutdated,
  readLockedVersions,
} from '@/managers/npm'
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

describe('check with npm', () => {
  it('carries wanted: the highest version the range allows', async () => {
    mockedRunProcess.mockRejectedValue(
      exitError(1, readFixture('npm/outdated-ranges.stdout'), ''),
    )

    const result = await check(projectFor(npm, '/project'))

    expect(result.react).toMatchObject({
      current: '18.2.0',
      wanted: '18.3.1',
      latest: '19.3.1',
    })
    expect(result.minimist).toMatchObject({ current: '1.2.7', wanted: '1.2.7' })
  })

  it('lists outdated packages when npm exits 1 with a JSON report', async () => {
    mockedRunProcess.mockRejectedValue(
      exitError(1, readFixture('npm/outdated.stdout'), ''),
    )

    const result = await check(projectFor(npm, '/project'))

    expect(Object.keys(result)).toHaveLength(40)
    expect(result.dayjs).toMatchObject({
      current: '1.11.9',
      wanted: '1.11.9',
      latest: '1.11.23',
    })
  })

  it('takes current from package-lock.json when nothing is installed', async () => {
    // A fresh clone: npm 11.19.1 leaves `current` out of every row.
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-npm-lock-'))
    fs.copyFileSync(
      path.join(__dirname, '../fixtures/npm/no-node-modules.package-lock.json'),
      path.join(cwd, 'package-lock.json'),
    )
    mockedRunProcess.mockRejectedValue(
      exitError(1, readFixture('npm/outdated-no-node-modules.stdout'), ''),
    )

    try {
      const result = await check(projectFor(npm, cwd))

      expect(Object.values(result).every((info) => info.current)).toBe(true)
      expect(result.chalk).toMatchObject({
        current: '4.0.0',
        wanted: '4.1.2',
        latest: '6.0.1',
      })
      expect(result.ms).toMatchObject({ current: '2.1.1', wanted: '2.1.1' })
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('fails when npm exits 1 with its JSON error object instead of a report', async () => {
    mockedRunProcess.mockRejectedValue(
      exitError(
        1,
        readFixture('npm/outdated-error.stdout'),
        readFixture('npm/outdated-error.stderr'),
      ),
    )

    await expect(check(projectFor(npm, '/project'))).rejects.toThrow(
      /ECONNREFUSED/,
    )
  })

  it('fails when npm exits with a code other than 0 or 1', async () => {
    mockedRunProcess.mockRejectedValue(exitError(2, '{}', 'npm error usage'))

    await expect(check(projectFor(npm, '/project'))).rejects.toThrow(
      /npm error usage/,
    )
  })
})

describe('parseNpmOutdated', () => {
  it('reads the report keyed by name, with the range-respecting wanted', () => {
    const result = parseNpmOutdated(readFixture('npm/outdated-ranges.stdout'))

    expect(Object.keys(result)).toHaveLength(40)
    expect(result.react).toMatchObject({
      current: '18.2.0',
      wanted: '18.3.1',
      latest: '19.3.1',
    })
    expect(result.minimist).toMatchObject({ current: '1.2.7', wanted: '1.2.7' })
  })

  it('reads empty stdout as nothing outdated', () => {
    expect(parseNpmOutdated('')).toEqual({})
  })

  it('fills a missing current from the locked versions', () => {
    const result = parseNpmOutdated(
      readFixture('npm/outdated-no-node-modules.stdout'),
      { 'node_modules/chalk': '4.0.0' },
    )

    expect(result.chalk.current).toBe('4.0.0')
  })

  it('marks a package neither installed nor locked as missing', () => {
    const result = parseNpmOutdated(
      readFixture('npm/outdated-no-node-modules.stdout'),
    )

    expect(result.chalk.current).toBe('missing')
  })

  it('looks an npm: alias up by its manifest key', () => {
    const result = parseNpmOutdated(
      JSON.stringify({
        'dj:dayjs@1.11.9': { wanted: '1.11.9', latest: '1.11.23' },
      }),
      { 'node_modules/dj': '1.11.9' },
    )

    expect(result['dj:dayjs@1.11.9'].current).toBe('1.11.9')
  })

  it('keeps the installed current over the lockfile', () => {
    const result = parseNpmOutdated(readFixture('npm/outdated-ranges.stdout'), {
      'node_modules/react': '0.0.1',
    })

    expect(result.react.current).toBe('18.2.0')
  })
})

describe('readLockedVersions', () => {
  it('reads every install path package-lock.json records', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-npm-lock-'))
    fs.copyFileSync(
      path.join(__dirname, '../fixtures/npm/no-node-modules.package-lock.json'),
      path.join(cwd, 'package-lock.json'),
    )

    try {
      expect(readLockedVersions(cwd)).toMatchObject({
        'node_modules/chalk': '4.0.0',
        'node_modules/ms': '2.1.1',
      })
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('is empty without a readable lockfile', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-npm-lock-'))

    try {
      expect(readLockedVersions(cwd)).toEqual({})
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

describe('parseNpmWorkspaceOutdated', () => {
  it('parses one entry per manifest, owners from dependedByLocation', () => {
    const entries = parseNpmWorkspaceOutdated(
      readFixture('npm/outdated-workspace.stdout'),
    )

    expect(entries).toHaveLength(5)
    expect(entries).toEqual(expect.arrayContaining(WORKSPACE_ENTRIES))
  })

  it("takes a member's missing current from its own lock entry, then the root's", () => {
    const report = JSON.stringify({
      ms: [
        {
          wanted: '2.1.2',
          latest: '2.1.3',
          dependedByLocation: 'packages/a',
        },
        { wanted: '2.1.3', latest: '2.1.3', dependedByLocation: '' },
      ],
      debug: {
        wanted: '4.3.7',
        latest: '4.4.3',
        dependedByLocation: 'packages/b',
      },
      dayjs: { wanted: '1.11.9', latest: '1.11.23', dependedByLocation: '' },
    })

    const entries = parseNpmWorkspaceOutdated(report, {
      'node_modules/ms': '2.1.1',
      'packages/a/node_modules/ms': '2.1.2',
      'node_modules/debug': '4.3.1',
    })

    expect(entries.map((e) => [e.name, e.workspace, e.current])).toEqual([
      ['ms', 'packages/a', '2.1.2'],
      ['ms', '.', '2.1.1'],
      ['debug', 'packages/b', '4.3.1'],
      ['dayjs', '.', 'missing'],
    ])
  })

  it('fails discovery when a row names no owner', () => {
    expect(() =>
      parseNpmWorkspaceOutdated(
        JSON.stringify({ ms: { current: '1', wanted: '1', latest: '2' } }),
      ),
    ).toThrow(StepError)
  })
})
