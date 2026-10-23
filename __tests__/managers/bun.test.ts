import BunManager from '@/managers/bun'
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

import { execAsync } from '@/utils'

const mockedExecAsync = jest.mocked(execAsync)

describe('BunManager.checkPackageVersions', () => {
  let manager: BunManager

  beforeEach(() => {
    manager = new BunManager()
  })

  it('lists outdated packages when bun exits 0 with its table', async () => {
    mockedExecAsync.mockResolvedValue({
      stdout: readFixture('bun/outdated.stdout'),
      stderr: '',
    })

    const result = await manager.checkPackageVersions('/project')

    expect(Object.keys(result)).toHaveLength(40)
    expect(result.dayjs).toEqual({
      name: 'dayjs',
      current: '1.11.9',
      latest: '1.11.23',
    })
  })

  it('fails when bun exits 1, even though it printed part of a report', async () => {
    mockedExecAsync.mockRejectedValue(
      exitError(
        1,
        readFixture('bun/outdated-error.stdout'),
        readFixture('bun/outdated-error.stderr'),
      ),
    )

    await expect(manager.checkPackageVersions('/project')).rejects.toThrow(
      /ConnectionRefused/,
    )
  })
})
