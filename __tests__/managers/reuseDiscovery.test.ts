import fs from 'fs'
import os from 'os'
import path from 'path'
import BunManager from '@/managers/bun'
import NPMManager from '@/managers/npm'
import PNPMManager from '@/managers/pnpm'
import YarnManager from '@/managers/yarn'
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
  ['npm', () => new NPMManager(), ['update', 'dayjs']],
  ['pnpm', () => new PNPMManager(), ['update', 'dayjs']],
  ['yarn', () => new YarnManager(), ['upgrade', 'dayjs@^1.11.9']],
  ['bun', () => new BunManager(), ['update', 'dayjs']],
] as const)(
  '%s updatePackages with a discovery result',
  (pm, create, applyArgs) => {
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
      const results = await create().updatePackages(
        cwd,
        ['dayjs'],
        outdatedPackages,
      )

      expect(mockedRunProcess).toHaveBeenCalledTimes(1)
      expect(mockedRunProcess).toHaveBeenCalledWith(pm, [...applyArgs], { cwd })
      expect(logger.outdatedHeader).not.toHaveBeenCalled()
      expect(results).toEqual([
        expect.objectContaining({ name: 'dayjs', updated: true }),
      ])
    })
  },
)
