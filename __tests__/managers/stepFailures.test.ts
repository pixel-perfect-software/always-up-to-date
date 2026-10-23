import fs from 'fs'
import os from 'os'
import path from 'path'
import BunManager from '@/managers/bun'
import NPMManager from '@/managers/npm'
import PNPMManager from '@/managers/pnpm'
import YarnManager from '@/managers/yarn'
import { StepError } from '@/stepError'
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

const outdatedPackages: Record<string, PackageInfo> = {
  dayjs: {
    name: 'dayjs',
    current: '1.11.9',
    wanted: '1.11.23',
    latest: '1.11.23',
  },
}

// Real pnpm 12 output: the update ran, then failed on an ignored build script.
const applyFailure = () =>
  exitError(
    1,
    readFixture('pnpm/update-ignored-builds.stdout'),
    readFixture('pnpm/update-ignored-builds.stderr'),
  )

describe.each([
  // npm, pnpm and bun write package.json before running the manager; yarn
  // writes it itself, so a failed yarn command leaves it untouched.
  ['npm', () => new NPMManager(), true],
  ['pnpm', () => new PNPMManager(), true],
  ['yarn', () => new YarnManager(), false],
  ['bun', () => new BunManager(), true],
] as const)('%s step failures', (pm, create, writesManifestFirst) => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), `autd-step-${pm}-`))
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { dayjs: '^1.11.9' } }),
    )
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  afterEach(() => {
    jest.mocked(loadConfig).mockReturnValue({ ...DEFAULT_CONFIG })
  })

  it('rejects with an apply StepError when an in-range apply fails', async () => {
    mockedRunProcess.mockRejectedValue(applyFailure())

    const error = await create()
      .updatePackages(cwd, ['dayjs'], outdatedPackages)
      .catch((e: unknown) => e)

    // In range, autd hands the name to the manager and writes nothing.
    expect(error).toBeInstanceOf(StepError)
    expect(error).toMatchObject({ step: 'apply', manifestWritten: false })
    expect((error as Error).message).toContain('ERR_PNPM_IGNORED_BUILDS')
  })

  it('flags the written manifest when a beyond-range apply fails', async () => {
    jest
      .mocked(loadConfig)
      .mockReturnValue({ ...DEFAULT_CONFIG, allowMinorUpdates: true })
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { dayjs: '1.11.9' } }),
    )
    mockedRunProcess.mockRejectedValue(applyFailure())

    const error = await create()
      .updatePackages(cwd, ['dayjs'], {
        dayjs: {
          name: 'dayjs',
          current: '1.11.9',
          wanted: '1.11.9',
          latest: '1.11.23',
        },
      })
      .catch((e: unknown) => e)

    expect(error).toMatchObject({
      step: 'apply',
      manifestWritten: writesManifestFirst,
    })
  })

  it('rejects with a discover StepError when discovery fails', async () => {
    mockedRunProcess.mockRejectedValue(
      exitError(2, '', `${pm}: registry unreachable`),
    )

    const error = await create()
      .updatePackages(cwd, ['dayjs'])
      .catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StepError)
    expect(error).toMatchObject({ step: 'discover', manifestWritten: false })
    expect((error as Error).message).toContain('registry unreachable')
  })
})
