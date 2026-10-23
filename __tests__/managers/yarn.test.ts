import fs from 'fs'
import os from 'os'
import path from 'path'
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
  runProcess: jest.fn(),
}))

import { logger, runProcess } from '@/utils'

const mockedRunProcess = jest.mocked(runProcess)

describe('YarnManager.checkPackageVersions (yarn v1)', () => {
  let manager: YarnManager

  beforeEach(() => {
    manager = new YarnManager()
  })

  it('lists outdated packages when yarn exits 1 with a Node deprecation warning on stderr', async () => {
    mockedRunProcess.mockRejectedValue(
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
    mockedRunProcess.mockResolvedValue({
      stdout: readFixture('yarn/v1-outdated-none.stdout'),
      stderr: readFixture('yarn/v1-outdated.stderr'),
    })

    await expect(manager.checkPackageVersions('/project')).resolves.toEqual({})
  })

  it('fails instead of reporting "up to date" when yarn exits 1 without a table', async () => {
    mockedRunProcess.mockRejectedValue(
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

describe('YarnManager.updatePackages', () => {
  let manager: YarnManager
  let cwd: string

  const writeProject = (
    manifest: Record<string, unknown>,
    extraFiles: Record<string, string> = {},
  ) => {
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify(manifest, null, 2),
    )
    for (const [name, content] of Object.entries(extraFiles)) {
      fs.writeFileSync(path.join(cwd, name), content)
    }
  }

  const readManifest = () =>
    JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))

  // First call: `yarn outdated --json`. Second call: the apply command.
  const mockOutdatedThenApply = (stdout: string, stderr = '') => {
    mockedRunProcess
      .mockRejectedValueOnce(
        exitError(
          1,
          readFixture('yarn/v1-outdated.stdout'),
          readFixture('yarn/v1-outdated.stderr'),
        ),
      )
      .mockResolvedValueOnce({ stdout, stderr })
  }

  beforeEach(() => {
    manager = new YarnManager()
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-yarn-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('runs `yarn upgrade` on v1 with a descriptor that keeps an exact pin exact', async () => {
    writeProject({ dependencies: { dayjs: '1.11.9' } })
    mockOutdatedThenApply(
      readFixture('yarn/v1-upgrade.stdout'),
      readFixture('yarn/v1-upgrade.stderr'),
    )

    const results = await manager.updatePackages(cwd, ['dayjs'])

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'dayjs@1.11.23'],
      expect.objectContaining({ cwd }),
    )
    expect(results.find((r) => r.name === 'dayjs')?.updated).toBe(true)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('leaves package.json for yarn to write, since v1 rejects a pre-written manifest', async () => {
    // Real yarn v1 output when the manifest is edited before `upgrade`.
    expect(readFixture('yarn/v1-upgrade-prewritten.stderr')).toContain(
      'Outdated lockfile',
    )
    const manifest = { dependencies: { dayjs: '1.11.9' } }
    writeProject(manifest)
    mockOutdatedThenApply(readFixture('yarn/v1-upgrade.stdout'))

    await manager.updatePackages(cwd, ['dayjs'])

    expect(readManifest()).toEqual(manifest)
  })

  it('keeps a caret range a caret range', async () => {
    writeProject({ dependencies: { ms: '^2.1.2' } })
    mockOutdatedThenApply(readFixture('yarn/v1-upgrade.stdout'))

    await manager.updatePackages(cwd, ['ms'])

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'ms@^2.1.3'],
      expect.anything(),
    )
  })

  it('takes the spec from devDependencies too', async () => {
    writeProject({ devDependencies: { dayjs: '~1.11.9' } })
    mockOutdatedThenApply(readFixture('yarn/v1-upgrade.stdout'))

    await manager.updatePackages(cwd, ['dayjs'])

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'dayjs@~1.11.23'],
      expect.anything(),
    )
  })

  it('runs `yarn up` on berry, detected from the packageManager field', async () => {
    writeProject({
      packageManager: 'yarn@4.18.1',
      dependencies: { dayjs: '1.11.9' },
    })
    mockOutdatedThenApply(readFixture('yarn/berry-up.stdout'))

    await manager.updatePackages(cwd, ['dayjs'])

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['up', 'dayjs@1.11.23'],
      expect.anything(),
    )
  })

  it('runs `yarn up` on berry, detected from .yarnrc.yml', async () => {
    writeProject(
      { dependencies: { dayjs: '1.11.9' } },
      { '.yarnrc.yml': 'nodeLinker: node-modules\n' },
    )
    mockOutdatedThenApply(readFixture('yarn/berry-up.stdout'))

    await manager.updatePackages(cwd, ['dayjs'])

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['up', 'dayjs@1.11.23'],
      expect.anything(),
    )
  })

  it('trusts packageManager yarn@1 over a stray .yarnrc.yml', async () => {
    writeProject(
      { packageManager: 'yarn@1.22.22', dependencies: { dayjs: '1.11.9' } },
      { '.yarnrc.yml': '' },
    )
    mockOutdatedThenApply(readFixture('yarn/v1-upgrade.stdout'))

    await manager.updatePackages(cwd, ['dayjs'])

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'dayjs@1.11.23'],
      expect.anything(),
    )
  })

  it('surfaces a failed apply command as an error', async () => {
    writeProject({ dependencies: { dayjs: '1.11.9' } })
    mockedRunProcess
      .mockRejectedValueOnce(
        exitError(1, readFixture('yarn/v1-outdated.stdout'), ''),
      )
      .mockRejectedValueOnce(
        // Real v1 output for the old `yarn update` command.
        exitError(
          1,
          readFixture('yarn/v1-update.stdout'),
          readFixture('yarn/v1-update.stderr'),
        ),
      )

    await manager.updatePackages(cwd, ['dayjs'])

    expect(logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Command "update" not found'),
    )
  })

  it('does not hand yarn a package the root manifest does not list', async () => {
    // yarn v1 `upgrade ms@2.1.3` at a workspace root adds ms to the root
    // dependencies when only a member declares it.
    writeProject({ dependencies: { dayjs: '1.11.9' } })
    mockOutdatedThenApply(readFixture('yarn/v1-upgrade.stdout'))

    await manager.updatePackages(cwd, ['dayjs', 'ms'])

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'dayjs@1.11.23'],
      expect.anything(),
    )
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ms'))
  })
})
