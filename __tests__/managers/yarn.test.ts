import YarnManager from '@/managers/yarn'
import { exitError, readFixture } from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils/config')
jest.mock('@/utils/registry', () => ({
  clearRegistryCache: jest.fn(),
  fetchReleaseTimes: jest.fn(),
}))
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  execAsync: jest.fn(),
}))

import { execAsync, logger } from '@/utils'

const mockedExecAsync = jest.mocked(execAsync)

describe('YarnManager.checkPackageVersions (yarn v1)', () => {
  let manager: YarnManager

  beforeEach(() => {
    manager = new YarnManager()
  })

  it('lists outdated packages when yarn exits 1 with a Node deprecation warning on stderr', async () => {
    mockedExecAsync.mockRejectedValue(
      exitError(
        1,
        readFixture('yarn/v1-outdated.stdout'),
        readFixture('yarn/v1-outdated.stderr'),
      ),
    )

    const result = await manager.checkPackageVersions('/project')

    expect(Object.keys(result)).toHaveLength(40)
    expect(result.dayjs).toEqual({
      name: 'dayjs',
      current: '1.11.9',
      latest: '1.11.23',
    })
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('[DEP0169] DeprecationWarning'),
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('reports nothing outdated when yarn exits 0 with empty stdout', async () => {
    mockedExecAsync.mockResolvedValue({
      stdout: readFixture('yarn/v1-outdated-none.stdout'),
      stderr: readFixture('yarn/v1-outdated.stderr'),
    })

    await expect(manager.checkPackageVersions('/project')).resolves.toEqual({})
  })

  it('fails instead of reporting "up to date" when yarn exits 1 without a table', async () => {
    mockedExecAsync.mockRejectedValue(
      exitError(
        1,
        readFixture('yarn/v1-outdated-error.stdout'),
        readFixture('yarn/v1-outdated-error.stderr'),
      ),
    )

    await expect(manager.checkPackageVersions('/project')).rejects.toThrow(
      /ECONNREFUSED/,
    )
    expect(logger.allUpToDate).not.toHaveBeenCalled()
  })
})
