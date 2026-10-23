import NPMManager from '@/managers/npm'
import { exitError, readFixture } from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils/config')
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

describe('NPMManager.checkPackageVersions', () => {
  let manager: NPMManager

  beforeEach(() => {
    manager = new NPMManager()
  })

  it('lists outdated packages when npm exits 1 with a JSON report', async () => {
    mockedRunProcess.mockRejectedValue(
      exitError(1, readFixture('npm/outdated.stdout'), ''),
    )

    const result = await manager.checkPackageVersions('/project')

    expect(Object.keys(result)).toHaveLength(40)
    expect(result.dayjs).toMatchObject({ current: '1.11.9', latest: '1.11.23' })
  })

  it('fails when npm exits 1 with its JSON error object instead of a report', async () => {
    mockedRunProcess.mockRejectedValue(
      exitError(
        1,
        readFixture('npm/outdated-error.stdout'),
        readFixture('npm/outdated-error.stderr'),
      ),
    )

    await expect(manager.checkPackageVersions('/project')).rejects.toThrow(
      /ECONNREFUSED/,
    )
  })

  it('fails when npm exits with a code other than 0 or 1', async () => {
    mockedRunProcess.mockRejectedValue(exitError(2, '{}', 'npm error usage'))

    await expect(manager.checkPackageVersions('/project')).rejects.toThrow(
      /npm error usage/,
    )
  })
})
