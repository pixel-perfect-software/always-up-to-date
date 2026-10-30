import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm from '@/managers/pnpm'
import yarn from '@/managers/yarn'
import { check, plan, update } from '@/pipeline'
import {
  capturedRegistry,
  installPackages,
  projectFor,
  writeWorkspaceProject,
} from './fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { logger, runProcess } from '@/utils'

// When the workspace fixtures were captured, so no version drifts with the registry.
const AS_OF = '2026-10-23T16:38:12-03:00'

const ADAPTERS = [
  { pm: 'npm', adapter: npm },
  { pm: 'pnpm', adapter: pnpm },
  { pm: 'yarn', adapter: yarn },
  { pm: 'bun', adapter: bun },
] as const

let cwd: string

beforeEach(() => {
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-member-run-'))
})

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true })
})

describe.each(ADAPTERS)('a member run with $pm', ({ adapter }) => {
  const member = { path: 'packages/b', name: '@ws/b' }
  const project = () => {
    writeWorkspaceProject(cwd, { pnpm: adapter.name === 'pnpm' })
    installPackages(cwd, '.', { dayjs: '1.11.9', ms: '2.1.1', debug: '4.3.1' })
    installPackages(cwd, 'packages/a', { ms: '2.1.2' })
    return projectFor(
      adapter,
      cwd,
      {},
      // ms is declared by the root and packages/a only: asking for it fails.
      capturedRegistry(['dayjs', 'debug'], { asOf: AS_OF }),
      member,
    )
  }

  it('checks only the member, which stays the owner of each row', async () => {
    const outdated = await check(project())

    expect(Object.keys(outdated)).toEqual(['dayjs', 'debug'])
    expect(outdated.dayjs.workspaces).toEqual([
      { path: 'packages/b', current: '1.11.9', wanted: '1.11.23' },
    ])
    expect(outdated.debug.workspaces?.map((w) => w.path)).toEqual([
      'packages/b',
    ])
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('announces the member instead of the workspace', async () => {
    await check(project())

    expect(logger.memberRun).toHaveBeenCalledWith(adapter.name, 'packages/b', 3)
    expect(logger.workspace).not.toHaveBeenCalled()
    expect(logger.report).toHaveBeenCalledWith(
      expect.any(Array),
      adapter.name,
      'plan',
      { member: 'packages/b' },
    )
  })

  it('plans rows that carry the member path', async () => {
    const p = project()
    const rows = await plan(p, await check(p, { report: false }))

    expect(rows.map((row) => [row.name, row.workspace])).toEqual([
      ['dayjs', 'packages/b'],
      ['debug', 'packages/b'],
    ])
  })

  it('does not apply from a member until that is wired', async () => {
    await expect(update(project())).rejects.toMatchObject({
      step: 'apply',
      message: expect.stringContaining('not wired yet (#123)'),
    })
    expect(runProcess).not.toHaveBeenCalled()
  })
})
