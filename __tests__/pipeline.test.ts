import fs from 'fs'
import os from 'os'
import path from 'path'
import npm from '@/managers/npm'
import { check, update } from '@/pipeline'
import {
  exitError,
  isolateNpmConfig,
  projectFor,
  readFixture,
  writeWorkspaceProject,
} from './fixtures'

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

// Keep the developer's own npm configuration out of every case.
let npmConfigDir: string
let restoreNpmConfig: () => void
beforeEach(() => {
  npmConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-npm-config-'))
  restoreNpmConfig = isolateNpmConfig(npmConfigDir)
})
afterEach(() => {
  restoreNpmConfig()
  fs.rmSync(npmConfigDir, { recursive: true, force: true })
})

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

  describe('a package the manager leaves in place', () => {
    const install = (name: string, version: string) => {
      fs.mkdirSync(path.join(cwd, 'node_modules', name), { recursive: true })
      fs.writeFileSync(
        path.join(cwd, 'node_modules', name, 'package.json'),
        JSON.stringify({ name, version }),
      )
    }

    // npm 11.19.1: express's send@0.17.1 pins ms@2.1.1 exactly, so
    // `npm update debug ms` moves debug and keeps the hoisted ms.
    it('reports the hoisted pin as not applied while the package that moved stays updated', async () => {
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({
          dependencies: { ms: '~2.1.1', express: '4.17.1', debug: '~4.3.1' },
        }),
      )
      install('ms', '2.1.1')
      install('debug', '4.3.1')
      install('express', '4.17.1')
      jest.mocked(runProcess).mockImplementation(async (_file, args) => {
        if (args[0] === 'outdated') {
          throw exitError(1, readFixture('npm/outdated-hoisted-pin.stdout'), '')
        }
        install('debug', '4.3.7')
        return { stdout: '', stderr: '' }
      })

      const results = await update(projectFor(npm, cwd))

      const updateCall = jest
        .mocked(runProcess)
        .mock.calls.find(([, args]) => args[0] === 'update')
      expect(updateCall?.[1]).toEqual(['update', 'debug', 'ms'])
      expect(results.find((r) => r.name === 'ms')).toMatchObject({
        updated: false,
        target: undefined,
        reason: 'not applied by npm (installed 2.1.1)',
      })
      expect(results.find((r) => r.name === 'debug')).toMatchObject({
        updated: true,
        target: '4.3.7',
      })
      expect(results.find((r) => r.name === 'express')?.updated).toBe(false)
    })
  })

  describe('a workspace project', () => {
    const install = (dir: string, name: string, version: string) => {
      const target = path.join(cwd, dir, 'node_modules', name)
      fs.mkdirSync(target, { recursive: true })
      fs.writeFileSync(
        path.join(target, 'package.json'),
        JSON.stringify({ name, version }),
      )
    }

    it('plans and verifies each manifest, reading a member before the root', async () => {
      writeWorkspaceProject(cwd)
      install('.', 'dayjs', '1.11.9')
      install('.', 'ms', '2.1.1')
      install('.', 'debug', '4.3.1')
      install('packages/a', 'ms', '2.1.2')
      jest.mocked(runProcess).mockImplementation(async (_file, args) => {
        if (args[0] === 'outdated') {
          throw exitError(1, readFixture('npm/outdated-workspace.stdout'), '')
        }
        install('.', 'debug', '4.3.7')
        install('.', 'ms', '2.1.3')
        return { stdout: '', stderr: '' }
      })

      const results = await update(projectFor(npm, cwd))

      const summary = results.map(({ name, workspace, updated, reason }) => ({
        name,
        workspace,
        updated,
        reason,
      }))
      // One workspace-wide command; --workspaces would skip the root's own.
      const applied = jest
        .mocked(runProcess)
        .mock.calls.map(([, args]) => args)
        .filter((args) => args[0] === 'update')
      expect(applied).toEqual([['update', 'dayjs', 'debug', 'ms']])
      expect(summary).toEqual([
        {
          name: 'dayjs',
          workspace: '.',
          updated: false,
          reason: 'patch beyond the range',
        },
        {
          name: 'dayjs',
          workspace: 'packages/b',
          updated: false,
          reason: 'not applied by npm (installed 1.11.9)',
        },
        {
          name: 'debug',
          workspace: 'packages/b',
          updated: true,
          reason: undefined,
        },
        { name: 'ms', workspace: '.', updated: true, reason: undefined },
        {
          name: 'ms',
          workspace: 'packages/a',
          updated: false,
          reason: 'patch beyond the range',
        },
      ])
    })

    it('writes a beyond-range move into the manifest that owns it and verifies it there', async () => {
      writeWorkspaceProject(cwd)
      install('.', 'dayjs', '1.11.9')
      install('.', 'ms', '2.1.1')
      install('.', 'debug', '4.3.1')
      install('packages/a', 'ms', '2.1.2')
      jest.mocked(runProcess).mockImplementation(async (_file, args) => {
        if (args[0] === 'outdated') {
          throw exitError(1, readFixture('npm/outdated-workspace.stdout'), '')
        }
        install('.', 'dayjs', '1.11.23')
        install('.', 'debug', '4.3.7')
        install('.', 'ms', '2.1.3')
        install('packages/a', 'ms', '2.1.3')
        return { stdout: '', stderr: '' }
      })

      const results = await update(
        projectFor(npm, cwd, { beyondRange: 'patch' }),
      )

      const read = (file: string) =>
        JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8')).dependencies
      expect(read('package.json').dayjs).toBe('1.11.23')
      expect(read('packages/a/package.json').ms).toBe('2.1.3')
      expect(read('packages/b/package.json').dayjs).toBe('^1.11.9')
      expect(
        results.find((r) => r.name === 'ms' && r.workspace === 'packages/a'),
      ).toMatchObject({ updated: true })
    })
  })
})
