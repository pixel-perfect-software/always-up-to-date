import npm, { parseNpmOutdated } from '@/managers/npm'
import { check } from '@/pipeline'
import { exitError, projectFor, readFixture } from '../fixtures'

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
})
