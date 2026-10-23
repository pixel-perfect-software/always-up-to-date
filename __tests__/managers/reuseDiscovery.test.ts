import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm from '@/managers/pnpm'
import yarn from '@/managers/yarn'
import { update } from '@/pipeline'
import type { PackageInfo } from '@/types'

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

const outdatedPackages: Record<string, PackageInfo> = {
  dayjs: {
    name: 'dayjs',
    current: '1.11.9',
    wanted: '1.11.23',
    latest: '1.11.23',
  },
}

describe.each([
  ['npm', npm, ['update', 'dayjs']],
  ['pnpm', pnpm, ['update', 'dayjs']],
  ['yarn', yarn, ['upgrade', 'dayjs@^1.11.9']],
  ['bun', bun, ['update', 'dayjs']],
] as const)('%s update with a discovery result', (pm, adapter, applyArgs) => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), `autd-reuse-${pm}-`))
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { dayjs: '^1.11.9' } }),
    )
    mockedRunProcess.mockResolvedValue({ stdout: '', stderr: '' })
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('applies without running outdated again', async () => {
    const results = await update(adapter, cwd, {
      targetPackages: ['dayjs'],
      discovered: outdatedPackages,
    })

    expect(mockedRunProcess).toHaveBeenCalledTimes(1)
    expect(mockedRunProcess).toHaveBeenCalledWith(pm, [...applyArgs], { cwd })
    expect(logger.outdatedHeader).not.toHaveBeenCalled()
    expect(results).toEqual([
      expect.objectContaining({ name: 'dayjs', updated: true }),
    ])
  })
})
