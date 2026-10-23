import fs from 'fs'
import os from 'os'
import path from 'path'
import BunManager from '@/managers/bun'
import NPMManager from '@/managers/npm'
import PNPMManager from '@/managers/pnpm'
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

import { filterPackages, runProcess } from '@/utils'
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
    create: () => new NPMManager(),
    report: 'npm/outdated-alias.stdout',
    exitsOne: true,
  },
  {
    pm: 'pnpm',
    create: () => new PNPMManager(),
    report: 'pnpm/outdated-alias.stdout',
    exitsOne: true,
  },
  {
    pm: 'yarn',
    create: () => new YarnManager(),
    report: 'yarn/v1-outdated-alias.stdout',
    exitsOne: true,
  },
  {
    pm: 'bun',
    create: () => new BunManager(),
    report: 'bun/outdated-alias.stdout',
    exitsOne: false,
  },
] as const)('$pm with an npm: alias', ({ pm, create, report, exitsOne }) => {
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
    const outdated = await create().checkPackageVersions(cwd)

    expect(Object.keys(outdated)).toContain('dj')
    expect(Object.keys(outdated)).not.toContain('dayjs')
    expect(Object.keys(outdated).some((name) => name.includes(':'))).toBe(false)
    expect(outdated.dj.name).toBe('dj')
  })

  it('plans the alias without throwing, whatever versions the manager reports', async () => {
    const outdated = await create().checkPackageVersions(cwd)

    const results = await filterPackages(outdated, { cwd, packageManager: pm })

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
