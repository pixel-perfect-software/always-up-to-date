import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm from '@/managers/pnpm'
import yarn from '@/managers/yarn'
import { update } from '@/pipeline'
import { StepError } from '@/stepError'
import type { PackageInfo } from '@/types'
import {
  exitError,
  fakeRegistry,
  installPackages,
  projectFor,
  readFixture,
} from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { runProcess } from '@/utils'

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
  ['npm', npm, true],
  ['pnpm', pnpm, true],
  ['yarn', yarn, false],
  ['bun', bun, true],
] as const)('%s step failures', (pm, adapter, writesManifestFirst) => {
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

  it('rejects with an apply StepError when an in-range apply fails', async () => {
    mockedRunProcess.mockRejectedValue(applyFailure())

    const error = await update(projectFor(adapter, cwd), {
      targetPackages: ['dayjs'],
      discovered: outdatedPackages,
    }).catch((e: unknown) => e)

    // In range, autd hands the name to the manager and writes nothing.
    expect(error).toBeInstanceOf(StepError)
    expect(error).toMatchObject({ step: 'apply', manifestWritten: false })
    expect((error as Error).message).toContain('ERR_PNPM_IGNORED_BUILDS')
  })

  it('flags the written manifest when a beyond-range apply fails', async () => {
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { dayjs: '1.11.9' } }),
    )
    mockedRunProcess.mockRejectedValue(applyFailure())

    const error = await update(
      projectFor(adapter, cwd, { allowMinorUpdates: true }),
      {
        targetPackages: ['dayjs'],
        discovered: {
          dayjs: {
            name: 'dayjs',
            current: '1.11.9',
            wanted: '1.11.9',
            latest: '1.11.23',
          },
        },
      },
    ).catch((e: unknown) => e)

    expect(error).toMatchObject({
      step: 'apply',
      manifestWritten: writesManifestFirst,
    })
  })

  it('rejects with a discover StepError when discovery fails', async () => {
    installPackages(cwd, '.', { dayjs: '1.11.9' })
    const registry = fakeRegistry({
      lookup: async (name) => ({
        ok: false,
        name,
        kind: 'request',
        reason: 'registry unreachable',
      }),
    })

    const error = await update(projectFor(adapter, cwd, {}, registry), {
      targetPackages: ['dayjs'],
    }).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(StepError)
    expect(error).toMatchObject({ step: 'discover', manifestWritten: false })
    expect((error as Error).message).toContain('dayjs: registry unreachable')
    expect(mockedRunProcess).not.toHaveBeenCalled()
  })
})
