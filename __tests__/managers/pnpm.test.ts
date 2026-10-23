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

  // pnpm runs `outdated` twice: the report, and `--compatible` for the
  // highest in-range versions.
  const mockReports = (report: string, compatible: string) =>
    mockedRunProcess.mockImplementation(async (_file, args) => {
      throw exitError(
        1,
        readFixture(args.includes('--compatible') ? compatible : report),
        '',
      )
    })

  it('lists outdated packages when pnpm exits 1 with a JSON report', async () => {
    mockReports('pnpm/outdated.stdout', 'pnpm/outdated-compatible.stdout')

    const result = await manager.checkPackageVersions('/project')

    expect(Object.keys(result)).toHaveLength(40)
    expect(result.dayjs).toMatchObject({
      current: '1.11.9',
      wanted: '1.11.9',
      latest: '1.11.23',
    })
  })

  it("takes wanted from the --compatible run, not from pnpm's lockfile wanted", async () => {
    mockReports(
      'pnpm/outdated-ranges.stdout',
      'pnpm/outdated-ranges-compatible.stdout',
    )

    const result = await manager.checkPackageVersions('/project')

    // react ^18.2.0: pnpm's own `wanted` is the lockfile's 18.2.0.
    expect(
      JSON.parse(readFixture('pnpm/outdated-ranges.stdout')).react.wanted,
    ).toBe('18.2.0')
    expect(result.react).toMatchObject({
      current: '18.2.0',
      wanted: '18.3.1',
      latest: '19.3.1',
    })
    // An exact pin has no compatible update, so wanted stays put.
    expect(result.minimist).toMatchObject({ current: '1.2.7', wanted: '1.2.7' })
    expect(mockedRunProcess).toHaveBeenCalledWith(
      'pnpm',
      ['outdated', '--json', '--compatible'],
      { cwd: '/project' },
    )
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
