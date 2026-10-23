import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm from '@/managers/pnpm'
import yarn from '@/managers/yarn'
import { check, plan } from '@/pipeline'
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

// The scratch project the fixtures come from: `dj` is an npm: alias.
const manifest = {
  dependencies: {
    zod: '3.x',
    express: '>=4.18.2 <5.0.0',
    semver: '~7.5.0 || ~7.6.0',
    dj: 'npm:dayjs@1.11.9',
    ms: '*',
  },
}

describe.each([
  {
    pm: 'npm',
    adapter: npm,
    report: 'npm/outdated-alias.stdout',
    exitsOne: true,
  },
  {
    pm: 'pnpm',
    adapter: pnpm,
    report: 'pnpm/outdated-alias.stdout',
    exitsOne: true,
  },
  {
    pm: 'yarn',
    adapter: yarn,
    report: 'yarn/v1-outdated-alias.stdout',
    exitsOne: true,
  },
  {
    pm: 'bun',
    adapter: bun,
    report: 'bun/outdated-alias.stdout',
    exitsOne: false,
  },
] as const)('$pm with an npm: alias', ({ pm, adapter, report, exitsOne }) => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), `autd-alias-${pm}-`))
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(manifest))
    mockedRunProcess.mockImplementation(async (_file, args) => {
      const stdout = readFixture(
        args.includes('--compatible')
          ? 'pnpm/outdated-alias-compatible.stdout'
          : report,
      )
      if (!exitsOne) return { stdout, stderr: '' }
      throw exitError(1, stdout, '')
    })
    jest
      .mocked(loadConfig)
      .mockReturnValue({ ...DEFAULT_CONFIG, beyondRange: 'major' })
  })

  afterEach(() => {
    jest.mocked(loadConfig).mockReturnValue({ ...DEFAULT_CONFIG })
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('reports the alias under its manifest key', async () => {
    const outdated = await check(adapter, cwd)

    expect(Object.keys(outdated)).toContain('dj')
    expect(Object.keys(outdated)).not.toContain('dayjs')
    expect(Object.keys(outdated).some((name) => name.includes(':'))).toBe(false)
    expect(outdated.dj.name).toBe('dj')
  })

  it('plans the alias without throwing, whatever versions the manager reports', async () => {
    const outdated = await check(adapter, cwd)

    const results = await plan(adapter, cwd, outdated)

    const dj = results.find((r) => r.name === 'dj')
    // yarn v1 reports the alias's latest as "exotic": nothing to move to.
    if (pm === 'yarn') {
      expect(dj).toMatchObject({
        updated: false,
        reason: 'invalid version (current 1.11.9, latest exotic)',
      })
    } else {
      expect(dj).toMatchObject({ updated: true, target: '1.11.23' })
    }
    expect(results.find((r) => r.name === 'zod')?.updated).toBe(true)
  })
})
