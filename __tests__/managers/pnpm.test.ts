import PNPMManager from '@/managers/pnpm'
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

describe('PNPMManager.checkPackageVersions', () => {
  let manager: PNPMManager

  beforeEach(() => {
    manager = new PNPMManager()
  })

  it('lists outdated packages when pnpm exits 1 with a JSON report', async () => {
    mockedRunProcess.mockRejectedValue(
      exitError(1, readFixture('pnpm/outdated.stdout'), ''),
    )

    const result = await manager.checkPackageVersions('/project')

    expect(Object.keys(result)).toHaveLength(40)
    expect(result.dayjs).toMatchObject({ current: '1.11.9', latest: '1.11.23' })
  })

  it('fails when pnpm exits 1 with an error and no report', async () => {
    mockedRunProcess.mockRejectedValue(
      exitError(1, '', readFixture('pnpm/outdated-error.stderr')),
    )

    await expect(manager.checkPackageVersions('/project')).rejects.toThrow(
      /ERR_PNPM_OUTDATED_REGISTRY_ERROR/,
    )
  })
})
