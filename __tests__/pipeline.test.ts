import fs from 'fs'
import os from 'os'
import path from 'path'
import npm from '@/managers/npm'
import { check, plan, update } from '@/pipeline'
import {
  capturedRegistry,
  fakeRegistry,
  installPackages,
  isolateNpmConfig,
  projectFor,
  writeWorkspaceProject,
} from './fixtures'

jest.mock('@/utils/config', () => ({
  ...jest.requireActual('@/utils/config'),
  loadConfig: jest.fn(),
}))
jest.mock('@/utils/logger')
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { runProcess } from '@/utils'
import { loadConfig } from '@/utils/config'
import logger from '@/utils/logger'

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

// The newest fixture these cases were written against (the workspace fixtures).
const AS_OF = '2026-10-23T16:38:12-03:00'
const registryFor = (...names: string[]) =>
  capturedRegistry(names, { asOf: AS_OF })

describe('pipeline', () => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-pipeline-'))
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { dayjs: '1.11.9' } }),
    )
    installPackages(cwd, '.', { dayjs: '1.11.9' })
    jest.mocked(runProcess).mockResolvedValue({ stdout: '', stderr: '' })
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('reads the config from the project and never loads it', async () => {
    const registry = registryFor('dayjs')
    await check(projectFor(npm, cwd, {}, registry))
    await update(projectFor(npm, cwd, {}, registry), {
      targetPackages: ['dayjs'],
    })

    expect(loadConfig).not.toHaveBeenCalled()
  })

  // Phase 2 of #123 only: member-scoped discovery replaces this guard.
  it('stops a member run in discover until member runs are wired', async () => {
    const project = projectFor(npm, cwd, {}, registryFor('dayjs'), {
      path: 'packages/a',
      name: '@ws/a',
    })

    await expect(check(project)).rejects.toMatchObject({
      step: 'discover',
      message: expect.stringContaining('member runs are not wired yet (#123)'),
    })
    expect(runProcess).not.toHaveBeenCalled()
  })

  it('plans with the config the project carries', async () => {
    const registry = registryFor('dayjs')
    // The manager moves dayjs to its target, so the post-apply check agrees.
    jest.mocked(runProcess).mockImplementation(async () => {
      installPackages(cwd, '.', { dayjs: '1.11.23' })
      return { stdout: '', stderr: '' }
    })

    // dayjs is an exact pin: held by default, moved once beyondRange allows it.
    const held = await update(projectFor(npm, cwd, {}, registry), {
      targetPackages: ['dayjs'],
    })
    const moved = await update(
      projectFor(npm, cwd, { beyondRange: 'patch' }, registry),
      { targetPackages: ['dayjs'] },
    )

    expect(held.find((r) => r.name === 'dayjs')?.updated).toBe(false)
    expect(moved.find((r) => r.name === 'dayjs')?.updated).toBe(true)
  })

  describe('a cooldown fallback (#151)', () => {
    // Publish times of ms, relative to the run: plan reads the real clock.
    const DAY = 24 * 60 * 60 * 1000
    const daysAgo = (days: number) =>
      new Date(Date.now() - days * DAY).toISOString()
    const times: Record<string, string> = {
      '0.7.3': daysAgo(3521),
      '2.1.2': daysAgo(2702),
      '2.1.3': daysAgo(2151),
    }
    const registry = fakeRegistry({
      releaseTimes: async () => times,
      lookup: async (name) => ({
        ok: true,
        package: {
          name,
          latest: '2.1.3',
          source: 'packument',
          versions: Object.keys(times).map((version) => ({
            version,
            deprecated: false,
          })),
        },
      }),
    })

    it('falls back within the range package.json declares', async () => {
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({ dependencies: { ms: '^0.7.1 || ^2.1.3' } }),
      )

      const [result] = await plan(
        projectFor(npm, cwd, { cooldown: 2200 }, registry),
        {
          ms: {
            name: 'ms',
            current: '0.7.1',
            wanted: '2.1.3',
            latest: '2.1.3',
          },
        },
      )

      expect(result).toMatchObject({ updated: true, target: '0.7.3' })
    })

    it("looks an npm: alias's dates up by its target (#152)", async () => {
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({ dependencies: { m: 'npm:ms@^2.0.0' } }),
      )
      const asked = new Set<string>()
      const aliasRegistry = fakeRegistry({
        releaseTimes: async (name) => {
          asked.add(name)
          return name === 'ms' ? times : {}
        },
        lookup: async (name) => {
          asked.add(name)
          return registry.lookup(name)
        },
      })

      const [result] = await plan(
        projectFor(npm, cwd, { cooldown: 2200 }, aliasRegistry),
        {
          m: { name: 'm', current: '2.0.0', wanted: '2.1.3', latest: '2.1.3' },
        },
      )

      expect(result).toMatchObject({
        name: 'm',
        updated: true,
        target: '2.1.2',
      })
      expect([...asked]).toEqual(['ms'])
    })
  })

  describe('a package the manager leaves in place', () => {
    const install = (name: string, version: string) =>
      installPackages(cwd, '.', { [name]: version })

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
      jest.mocked(runProcess).mockImplementation(async () => {
        install('debug', '4.3.7')
        return { stdout: '', stderr: '' }
      })

      const results = await update(
        projectFor(npm, cwd, {}, registryFor('ms', 'express', 'debug')),
      )

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

      // One report, after apply, carrying every row: nothing is listed twice (#138).
      expect(logger.report).toHaveBeenCalledTimes(1)
      expect(logger.report).toHaveBeenCalledWith(results, 'npm', 'applied')
    })
  })

  describe('a workspace project', () => {
    const install = (dir: string, name: string, version: string) =>
      installPackages(cwd, dir, { [name]: version })
    const workspaceRegistry = () => registryFor('dayjs', 'ms', 'debug')

    it('plans and verifies each manifest, reading a member before the root', async () => {
      writeWorkspaceProject(cwd)
      install('.', 'dayjs', '1.11.9')
      install('.', 'ms', '2.1.1')
      install('.', 'debug', '4.3.1')
      install('packages/a', 'ms', '2.1.2')
      jest.mocked(runProcess).mockImplementation(async () => {
        install('.', 'debug', '4.3.7')
        install('.', 'ms', '2.1.3')
        return { stdout: '', stderr: '' }
      })

      const results = await update(
        projectFor(npm, cwd, {}, workspaceRegistry()),
      )

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
      jest.mocked(runProcess).mockImplementation(async () => {
        install('.', 'dayjs', '1.11.23')
        install('.', 'debug', '4.3.7')
        install('.', 'ms', '2.1.3')
        install('packages/a', 'ms', '2.1.3')
        return { stdout: '', stderr: '' }
      })

      const results = await update(
        projectFor(npm, cwd, { beyondRange: 'patch' }, workspaceRegistry()),
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
