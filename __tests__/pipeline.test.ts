import fs from 'fs'
import path from 'path'
import npm from '@/managers/npm'
import { check, findOutdated, plan, update } from '@/pipeline'
import type { VersionManifest } from '@/types'
import {
  capturedManifest,
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
jest.mock('@/utils/runProcess', () => ({
  ...jest.requireActual('@/utils/runProcess'),
  runProcess: jest.fn(),
}))

import { loadConfig } from '@/utils/config'
import logger from '@/utils/logger'
import { runProcess } from '@/utils/runProcess'
import { tempDir } from './fixtures/files'
import { reasonFor } from './fixtures/reasons'

// Keep the developer's own npm configuration out of every case.
let npmConfigDir: string
let restoreNpmConfig: () => void
beforeEach(() => {
  npmConfigDir = tempDir('autd-npm-config-')
  restoreNpmConfig = isolateNpmConfig(npmConfigDir)
})
afterEach(() => {
  restoreNpmConfig()
})

// The newest fixture these cases were written against (the workspace fixtures).
const AS_OF = '2026-10-23T16:38:12-03:00'
const registryFor = (...names: string[]) =>
  capturedRegistry(names, { asOf: AS_OF })

describe('pipeline', () => {
  let cwd: string

  beforeEach(() => {
    cwd = tempDir('autd-pipeline-')
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { dayjs: '1.11.9' } }),
    )
    installPackages(cwd, '.', { dayjs: '1.11.9' })
    jest.mocked(runProcess).mockResolvedValue({ stdout: '', stderr: '' })
  })

  it('reads the config from the project and never loads it', async () => {
    const registry = registryFor('dayjs')
    await check(projectFor(npm, cwd, {}, registry))
    await update(projectFor(npm, cwd, {}, registry), {
      targetPackages: ['dayjs'],
    })

    expect(loadConfig).not.toHaveBeenCalled()
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

  describe('named targets (#222)', () => {
    const declare = (dependencies: Record<string, string>) =>
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({ dependencies }),
      )

    it('fails for a name the manifest does not declare, before any lookup', async () => {
      const registry = registryFor('dayjs')
      const lookup = jest.spyOn(registry, 'lookup')
      const p = projectFor(npm, cwd, {}, registry)

      await expect(findOutdated(p, ['leftpad-nope'])).rejects.toMatchObject({
        step: 'discover',
        message: "leftpad-nope isn't a dependency of this project",
      })
      await expect(
        update(p, { targetPackages: ['dayjs', 'a-nope', 'b-nope'] }),
      ).rejects.toMatchObject({
        step: 'discover',
        message: "a-nope, b-nope aren't dependencies of this project",
      })

      expect(lookup).not.toHaveBeenCalled()
      expect(logger.starting).not.toHaveBeenCalled()
      expect(runProcess).not.toHaveBeenCalled()
    })

    it('names a dependency that is already current and still plans the rest', async () => {
      declare({ dayjs: '1.11.9', ms: '2.1.3' })
      installPackages(cwd, '.', { dayjs: '1.11.9', ms: '2.1.3' })
      const p = projectFor(npm, cwd, {}, registryFor('dayjs', 'ms'))

      const outdated = await findOutdated(p, ['ms', 'dayjs'])

      expect(Object.keys(outdated)).toEqual(['dayjs'])
      expect(logger.info).toHaveBeenCalledTimes(1)
      expect(logger.info).toHaveBeenCalledWith('ms is already up to date')
    })

    it('names the current dependency when the update has nothing to move', async () => {
      declare({ ms: '2.1.3' })
      installPackages(cwd, '.', { ms: '2.1.3' })
      const p = projectFor(npm, cwd, {}, registryFor('ms'))

      await expect(update(p, { targetPackages: ['ms'] })).resolves.toEqual([])

      expect(logger.info).toHaveBeenCalledWith('ms is already up to date')
    })

    it('reads a dependency that is not installed as missing, naming the fix', async () => {
      declare({ ms: '2.1.3' })
      fs.rmSync(path.join(cwd, 'node_modules'), { recursive: true })
      installPackages(cwd, '.', { dayjs: '1.11.9' })
      const p = projectFor(npm, cwd, {}, registryFor('ms'))

      const [row] = await plan(p, await findOutdated(p))

      expect(row.reason).toEqual({
        code: 'not-installed',
        message: 'not installed: run npm install',
      })
    })
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

  describe('a deprecated target (#195)', () => {
    // lodash 4.18.0 was `latest` for a day, until 4.18.1 replaced it.
    const LODASH_DAY = { asOf: '2026-04-01T00:00:00Z' }

    it("holds it with the registry's message, from discovery's lookup, by an alias's target too", async () => {
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({
          dependencies: { lodash: '4.17.21', l: 'npm:lodash@4.17.21' },
        }),
      )
      installPackages(cwd, '.', { lodash: '4.17.21', l: '4.17.21' })
      const captured = capturedRegistry(['lodash'], LODASH_DAY)
      const asked: string[] = []
      const project = projectFor(
        npm,
        cwd,
        { beyondRange: 'minor' },
        {
          ...captured,
          lookup: (name) => {
            asked.push(name)
            return captured.lookup(name)
          },
        },
      )

      const results = await plan(project, await check(project))

      expect(results).toEqual([
        expect.objectContaining({
          name: 'l',
          updated: false,
          reason: reasonFor(
            'deprecated: Bad release. Please use lodash@4.17.21 instead.',
          ),
        }),
        expect.objectContaining({
          name: 'lodash',
          updated: false,
          reason: reasonFor(
            'deprecated: Bad release. Please use lodash@4.17.21 instead.',
          ),
        }),
      ])
      // Discovery's lookups only: the plan asked for nothing.
      expect(asked).toEqual(['lodash'])
    })
  })

  describe('a license check without node_modules (#197)', () => {
    it("asks for the locked version's manifest once, and for its target's", async () => {
      fs.rmSync(path.join(cwd, 'node_modules'), { recursive: true })
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({ name: 'project', dependencies: { ms: '2.1.1' } }),
      )
      fs.copyFileSync(
        path.join(__dirname, 'fixtures/npm/no-node-modules.package-lock.json'),
        path.join(cwd, 'package-lock.json'),
      )
      const known: Record<string, VersionManifest> = {
        'ms@2.1.1': capturedManifest('ms', '2.1.1', 'ms.2.1.1.manifest'),
        'ms@2.1.3': capturedManifest('ms', '2.1.3', 'ms.2.1.3.manifest'),
      }
      const asked: string[] = []
      const project = projectFor(
        npm,
        cwd,
        { beyondRange: 'patch' },
        {
          ...registryFor('ms'),
          versionManifest: async (name, version) => {
            asked.push(`${name}@${version}`)
            return known[`${name}@${version}`]
          },
        },
      )

      const results = await plan(project, await findOutdated(project))

      expect(results).toEqual([
        expect.objectContaining({
          name: 'ms',
          current: '2.1.1',
          target: '2.1.3',
          updated: true,
        }),
      ])
      expect(asked.sort()).toEqual(['ms@2.1.1', 'ms@2.1.3'])
      expect(logger.warn).not.toHaveBeenCalled()
    })
  })

  describe("a target's peers without node_modules (#198)", () => {
    // npm 11.19.1 `install --package-lock-only` of react 17.0.2 and
    // react-redux 8.1.3: the lockfile records react at 17.0.2.
    it('holds a target whose peer the lockfile records outside its range', async () => {
      fs.rmSync(path.join(cwd, 'node_modules'), { recursive: true })
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({
          name: 'peers-no-node-modules',
          dependencies: { react: '17.0.2', 'react-redux': '8.1.3' },
        }),
      )
      fs.copyFileSync(
        path.join(
          __dirname,
          'fixtures/npm/peers-no-node-modules.package-lock.json',
        ),
        path.join(cwd, 'package-lock.json'),
      )
      const known: Record<string, VersionManifest> = {
        'react-redux@9.2.0': capturedManifest(
          'react-redux',
          '9.2.0',
          'react-redux.9.2.0.manifest',
        ),
        'react-redux@8.1.3': capturedManifest(
          'react-redux',
          '8.1.3',
          'react-redux.8.1.3.manifest',
        ),
        'react@17.0.2': {
          ...capturedManifest('react', '18.3.1', 'react.18.3.1.manifest'),
          version: '17.0.2',
        },
      }
      const project = projectFor(
        npm,
        cwd,
        { beyondRange: 'major' },
        {
          ...fakeRegistry(),
          versionManifest: async (name, version) => known[`${name}@${version}`],
        },
      )

      const results = await plan(project, {
        'react-redux': {
          name: 'react-redux',
          current: '8.1.3',
          wanted: '8.1.3',
          latest: '9.2.0',
        },
      })

      expect(results).toEqual([
        expect.objectContaining({
          name: 'react-redux',
          updated: false,
          reason: reasonFor(
            'peer conflict: react-redux@9.2.0 needs react ^18.0 || ^19 (installed 17.0.2)',
            'target-peers',
          ),
        }),
      ])
    })
  })

  describe("an installed package's peers without node_modules (#232)", () => {
    // The same capture: react-redux 8.1.3 is locked with a peer range of
    // react `^16.8 || ^17.0 || ^18.0`, and there is no node_modules to read.
    it('holds a target the lockfile records an installed peer range excluding', async () => {
      fs.rmSync(path.join(cwd, 'node_modules'), { recursive: true })
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({
          name: 'peers-no-node-modules',
          dependencies: { react: '17.0.2', 'react-redux': '8.1.3' },
        }),
      )
      fs.copyFileSync(
        path.join(
          __dirname,
          'fixtures/npm/peers-no-node-modules.package-lock.json',
        ),
        path.join(cwd, 'package-lock.json'),
      )
      const project = projectFor(npm, cwd, { beyondRange: 'major' })

      const results = await plan(project, {
        react: {
          name: 'react',
          current: '17.0.2',
          wanted: '17.0.2',
          latest: '19.2.0',
        },
      })

      expect(results).toEqual([
        expect.objectContaining({
          name: 'react',
          updated: false,
          reason: reasonFor(
            'peer conflict: react-redux@8.1.3 needs react ^16.8 || ^17.0 || ^18.0',
            'peer-conflict',
          ),
        }),
      ])
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
        reason: reasonFor('not applied by npm (installed 2.1.1)'),
      })
      expect(results.find((r) => r.name === 'debug')).toMatchObject({
        updated: true,
        target: '4.3.7',
      })
      expect(results.find((r) => r.name === 'express')?.updated).toBe(false)

      // One report, after apply, carrying every row: nothing is listed twice (#138).
      expect(logger.report).toHaveBeenCalledTimes(1)
      expect(logger.report).toHaveBeenCalledWith(results, 'npm', 'applied', {
        elapsedMs: expect.any(Number),
      })
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
          reason: reasonFor('patch beyond the range'),
        },
        {
          name: 'dayjs',
          workspace: 'packages/b',
          updated: false,
          reason: reasonFor('not applied by npm (installed 1.11.9)'),
        },
        {
          name: 'debug',
          workspace: 'packages/b',
          updated: true,
          reason: reasonFor('within range'),
        },
        {
          name: 'ms',
          workspace: '.',
          updated: true,
          reason: reasonFor('within range'),
        },
        {
          name: 'ms',
          workspace: 'packages/a',
          updated: false,
          reason: reasonFor('patch beyond the range'),
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
