import fs from 'fs'
import os from 'os'
import path from 'path'
import npm from '@/managers/npm'
import { check, update } from '@/pipeline'
import { exitError, projectFor, readFixture } from './fixtures'

jest.mock('@/utils/config', () => ({
  ...jest.requireActual('@/utils/config'),
  loadConfig: jest.fn(),
}))
jest.mock('@/utils/logger')
jest.mock('@/utils/registry', () => ({
  clearRegistryCache: jest.fn(),
  fetchReleaseTimes: jest.fn(),
}))
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { runProcess } from '@/utils'
import { loadConfig } from '@/utils/config'

describe('pipeline', () => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-pipeline-'))
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { dayjs: '1.11.9' } }),
    )
    jest
      .mocked(runProcess)
      .mockRejectedValue(exitError(1, readFixture('npm/outdated.stdout'), ''))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('reads the config from the project and never loads it', async () => {
    await check(projectFor(npm, cwd))
    await update(projectFor(npm, cwd), { targetPackages: ['dayjs'] })

    expect(loadConfig).not.toHaveBeenCalled()
  })

  it('plans with the config the project carries', async () => {
    jest.mocked(runProcess).mockImplementation(async (_file, args) => {
      if (args[0] === 'outdated') {
        throw exitError(1, readFixture('npm/outdated.stdout'), '')
      }
      return { stdout: '', stderr: '' }
    })

    // dayjs is an exact pin: held by default, moved once beyondRange allows it.
    const held = await update(projectFor(npm, cwd), {
      targetPackages: ['dayjs'],
    })
    const moved = await update(projectFor(npm, cwd, { beyondRange: 'patch' }), {
      targetPackages: ['dayjs'],
    })

    expect(held.find((r) => r.name === 'dayjs')?.updated).toBe(false)
    expect(moved.find((r) => r.name === 'dayjs')?.updated).toBe(true)
  })
})
