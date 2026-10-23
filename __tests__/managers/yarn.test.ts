import fs from 'fs'
import os from 'os'
import path from 'path'
import yarn, { parseYarnOutdated } from '@/managers/yarn'
import { check, update } from '@/pipeline'
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

import { logger, runProcess } from '@/utils'

const mockedRunProcess = jest.mocked(runProcess)

describe('check with yarn v1', () => {
  it('carries wanted from the Wanted column', async () => {
    mockedRunProcess.mockRejectedValue(
      exitError(1, readFixture('yarn/v1-outdated-ranges.stdout'), ''),
    )

    const result = await check(projectFor(yarn, '/project'))

    expect(result.react).toMatchObject({
      current: '18.2.0',
      wanted: '18.3.1',
      latest: '19.3.1',
    })
    expect(result.minimist).toMatchObject({ current: '1.2.7', wanted: '1.2.7' })
  })

  it('lists outdated packages when yarn exits 1 with a Node deprecation warning on stderr', async () => {
    mockedRunProcess.mockRejectedValue(
      exitError(
        1,
        readFixture('yarn/v1-outdated.stdout'),
        readFixture('yarn/v1-outdated.stderr'),
      ),
    )

    const result = await check(projectFor(yarn, '/project'))

    expect(Object.keys(result)).toHaveLength(40)
    expect(result.dayjs).toEqual({
      name: 'dayjs',
      current: '1.11.9',
      wanted: '1.11.9',
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

    await expect(check(projectFor(yarn, '/project'))).resolves.toEqual({})
  })

  it('fails instead of reporting "up to date" when yarn exits 1 without a table', async () => {
    mockedRunProcess.mockRejectedValue(
      exitError(
        1,
        readFixture('yarn/v1-outdated-error.stdout'),
        readFixture('yarn/v1-outdated-error.stderr'),
      ),
    )

    await expect(check(projectFor(yarn, '/project'))).rejects.toThrow(
      /ECONNREFUSED/,
    )
    expect(logger.allUpToDate).not.toHaveBeenCalled()
  })
})

describe('update with yarn', () => {
  let cwd: string

  // Most cases here move exact pins, which needs a beyond-range level.
  const movePins = { allowMinorUpdates: true }

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
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-yarn-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('keeps the current spec for an in-range update, on v1 and berry', async () => {
    const outdatedRanges = exitError(
      1,
      readFixture('yarn/v1-outdated-ranges.stdout'),
      '',
    )

    writeProject({ dependencies: { dayjs: '^1.11.9' } })
    mockedRunProcess
      .mockRejectedValueOnce(outdatedRanges)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    await update(projectFor(yarn, cwd), { targetPackages: ['dayjs'] })
    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'dayjs@^1.11.9'],
      expect.anything(),
    )

    // A bare `yarn up dayjs` on berry would jump to latest and rewrite the spec.
    writeProject({
      packageManager: 'yarn@4.18.1',
      dependencies: { dayjs: '^1.11.9' },
    })
    mockedRunProcess
      .mockRejectedValueOnce(outdatedRanges)
      .mockResolvedValueOnce({ stdout: '', stderr: '' })
    await update(projectFor(yarn, cwd), { targetPackages: ['dayjs'] })
    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['up', 'dayjs@^1.11.9'],
      expect.anything(),
    )
  })

  it('runs `yarn upgrade` on v1 with a descriptor that keeps an exact pin exact', async () => {
    writeProject({ dependencies: { dayjs: '1.11.9' } })
    mockOutdatedThenApply(
      readFixture('yarn/v1-upgrade.stdout'),
      readFixture('yarn/v1-upgrade.stderr'),
    )

    const results = await update(projectFor(yarn, cwd, movePins), {
      targetPackages: ['dayjs'],
    })

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

    await update(projectFor(yarn, cwd, movePins), { targetPackages: ['dayjs'] })

    expect(readManifest()).toEqual(manifest)
  })

  it('keeps a caret range a caret range', async () => {
    writeProject({ dependencies: { ms: '^2.1.2' } })
    mockOutdatedThenApply(readFixture('yarn/v1-upgrade.stdout'))

    await update(projectFor(yarn, cwd, movePins), { targetPackages: ['ms'] })

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'ms@^2.1.3'],
      expect.anything(),
    )
  })

  it('takes the spec from devDependencies too', async () => {
    writeProject({ devDependencies: { dayjs: '~1.11.9' } })
    mockOutdatedThenApply(readFixture('yarn/v1-upgrade.stdout'))

    await update(projectFor(yarn, cwd, movePins), { targetPackages: ['dayjs'] })

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

    await update(projectFor(yarn, cwd, movePins), { targetPackages: ['dayjs'] })

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

    await update(projectFor(yarn, cwd, movePins), { targetPackages: ['dayjs'] })

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

    await update(projectFor(yarn, cwd, movePins), { targetPackages: ['dayjs'] })

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

    await expect(
      update(projectFor(yarn, cwd, movePins), { targetPackages: ['dayjs'] }),
    ).rejects.toMatchObject({
      step: 'apply',
      manifestWritten: false,
      message: expect.stringContaining('Command "update" not found'),
    })
  })

  it('does not hand yarn a package the root manifest does not list', async () => {
    // yarn v1 `upgrade ms@2.1.3` at a workspace root adds ms to the root
    // dependencies when only a member declares it.
    writeProject({ dependencies: { dayjs: '1.11.9' } })
    mockOutdatedThenApply(readFixture('yarn/v1-upgrade.stdout'))

    await update(projectFor(yarn, cwd, movePins), {
      targetPackages: ['dayjs', 'ms'],
    })

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'dayjs@1.11.23'],
      expect.anything(),
    )
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ms'))
  })
})

describe('parseYarnOutdated', () => {
  it('reads the rows of the table line, Wanted column included', () => {
    const result = parseYarnOutdated(
      readFixture('yarn/v1-outdated-ranges.stdout'),
    )

    expect(Object.keys(result)).toHaveLength(40)
    expect(result.react).toEqual({
      name: 'react',
      current: '18.2.0',
      wanted: '18.3.1',
      latest: '19.3.1',
    })
  })

  it('reads output without a table, or no output, as nothing outdated', () => {
    expect(
      parseYarnOutdated(readFixture('yarn/v1-outdated-none.stdout')),
    ).toEqual({})
    expect(parseYarnOutdated('')).toEqual({})
  })
})
