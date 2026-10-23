import fs from 'fs'
import os from 'os'
import path from 'path'
import PNPMManager from '@/managers/pnpm'
import type { PackageInfo } from '@/types'
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
import { DEFAULT_CONFIG, loadConfig } from '@/utils/config'

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

describe('PNPMManager.checkIfInWorkspace', () => {
  let cwd: string
  const manager = new PNPMManager()

  const writeWorkspaceYaml = (content: string) =>
    fs.writeFileSync(path.join(cwd, 'pnpm-workspace.yaml'), content)

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-pnpm-workspace-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('is false without pnpm-workspace.yaml', async () => {
    expect(await manager.checkIfInWorkspace(cwd)).toBe(false)
  })

  // Since pnpm 10, settings live in pnpm-workspace.yaml, so a single-package
  // project often has one.
  it.each([
    ['settings only', 'onlyBuiltDependencies: []\n'],
    ['overrides only', 'overrides:\n  dayjs: 1.11.9\n'],
    ['an empty flow list', 'packages: []\n'],
    ['an empty packages key', 'packages:\noverrides:\n  dayjs: 1.11.9\n'],
  ])('is false for a file with %s', async (_, yaml) => {
    writeWorkspaceYaml(yaml)
    expect(await manager.checkIfInWorkspace(cwd)).toBe(false)
  })

  it.each([
    ['an indented block list', "packages:\n  - 'packages/*'\n"],
    ['a block list at column 0', 'packages:\n- apps/*\n'],
    ['a block list after a comment', 'packages:\n  # apps\n  - apps/*\n'],
    ['a flow list', "packages: ['packages/*']\n"],
    ['settings around it', 'overrides:\n  ms: 2.1.1\npackages:\n  - a\n'],
  ])('is true for %s of packages', async (_, yaml) => {
    writeWorkspaceYaml(yaml)
    expect(await manager.checkIfInWorkspace(cwd)).toBe(true)
  })

  it('discovers without -r when the file only holds settings', async () => {
    writeWorkspaceYaml('onlyBuiltDependencies: []\n')
    mockedRunProcess.mockResolvedValue({ stdout: '{}', stderr: '' })

    await manager.checkPackageVersions(cwd)

    expect(mockedRunProcess).toHaveBeenCalledWith(
      'pnpm',
      ['outdated', '--json'],
      { cwd },
    )
    expect(mockedRunProcess).not.toHaveBeenCalledWith(
      'pnpm',
      expect.arrayContaining(['-r']),
      expect.anything(),
    )
  })
})

describe('PNPMManager.updatePackages in a single-package project', () => {
  let cwd: string

  // react ^18.2.0 moves within its range; dayjs moves past its pin.
  const outdated: Record<string, PackageInfo> = {
    react: {
      name: 'react',
      current: '18.2.0',
      wanted: '18.3.1',
      latest: '19.3.1',
    },
    dayjs: {
      name: 'dayjs',
      current: '1.11.9',
      wanted: '1.11.9',
      latest: '1.11.23',
    },
  }

  const write = (file: string, content: string) =>
    fs.writeFileSync(path.join(cwd, file), content)
  const read = (file: string) => fs.readFileSync(path.join(cwd, file), 'utf8')

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-pnpm-single-'))
    mockedRunProcess.mockResolvedValue({ stdout: '', stderr: '' })
    jest
      .mocked(loadConfig)
      .mockReturnValue({ ...DEFAULT_CONFIG, beyondRange: 'patch' })
  })

  afterEach(() => {
    jest.mocked(loadConfig).mockReturnValue({ ...DEFAULT_CONFIG })
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('takes the single-project path when pnpm-workspace.yaml only holds settings', async () => {
    write(
      'package.json',
      JSON.stringify({ dependencies: { react: '^18.2.0', dayjs: '1.11.9' } }),
    )
    write('pnpm-workspace.yaml', 'onlyBuiltDependencies: []\n')

    await new PNPMManager().updatePackages(cwd, undefined, outdated)

    expect(mockedRunProcess.mock.calls.map(([, args]) => args)).toEqual([
      ['update', 'react', 'dayjs'],
    ])
    expect(JSON.parse(read('package.json')).dependencies.dayjs).toBe('1.11.23')
  })

  it('writes a catalog entry without treating the project as a workspace', async () => {
    write(
      'package.json',
      JSON.stringify({ dependencies: { react: '^18.2.0', dayjs: 'catalog:' } }),
    )
    write('pnpm-workspace.yaml', 'catalog:\n  dayjs: 1.11.9\n')

    await new PNPMManager().updatePackages(cwd, undefined, outdated)

    expect(read('pnpm-workspace.yaml')).toBe('catalog:\n  dayjs: 1.11.23\n')
    expect(JSON.parse(read('package.json')).dependencies.dayjs).toBe('catalog:')
    expect(mockedRunProcess.mock.calls.map(([, args]) => args)).toEqual([
      ['install'],
      ['update', 'react'],
    ])
  })
})
