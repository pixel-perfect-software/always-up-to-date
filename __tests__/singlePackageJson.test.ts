import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm from '@/managers/pnpm'
import yarn from '@/managers/yarn'
import { check, plan, update } from '@/pipeline'
import { exitError, projectFor, readFixture } from './fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { runProcess } from '@/utils'

const mockedRunProcess = jest.mocked(runProcess)

const manifest = {
  dependencies: {
    zod: '3.x',
    express: '>=4.18.2 <5.0.0',
    semver: '~7.5.0 || ~7.6.0',
    dj: 'npm:dayjs@1.11.9',
    ms: '*',
  },
}

const json = (value: unknown): string => JSON.stringify(value, null, 2)

/**
 * Pins the exact bytes single-package projects print with `--json`, so no
 * later change to workspace handling can alter them. Never update this
 * snapshot to make a workspace change pass.
 */
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
] as const)('$pm single-package JSON', ({ pm, adapter, report, exitsOne }) => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), `autd-single-json-${pm}-`))
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
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  describe.each([
    { label: 'default config', config: {} },
    { label: 'beyondRange major', config: { beyondRange: 'major' as const } },
  ])('$label', ({ config }) => {
    it('check', async () => {
      const outdated = await check(projectFor(adapter, cwd, config))
      expect(json(outdated)).toMatchSnapshot()
    })

    it('plan', async () => {
      const project = projectFor(adapter, cwd, config)
      const outdated = await check(project)
      expect(json(await plan(project, outdated))).toMatchSnapshot()
    })

    it('update', async () => {
      const apply = jest.fn().mockResolvedValue(undefined)
      const project = projectFor({ ...adapter, apply }, cwd, config)
      expect(json(await update(project))).toMatchSnapshot()
    })
  })
})
