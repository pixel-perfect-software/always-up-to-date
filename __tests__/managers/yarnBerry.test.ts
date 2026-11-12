import fs from 'fs'
import path from 'path'
import yarn from '@/managers/yarn'
import { readBerryLock } from '@/managers/yarn/berry'
import { check, plan, update } from '@/pipeline'
import type { OutdatedEntry } from '@/types'
import { foldWorkspaceEntries } from '@/utils/workspaceRows'
import {
  capturedManifest,
  capturedRegistry,
  exitError,
  fakeRegistry,
  projectFor,
  readFixture,
} from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils/runProcess', () => ({
  ...jest.requireActual('@/utils/runProcess'),
  runProcess: jest.fn(),
}))

import { runProcess } from '@/utils/runProcess'
import { tempDir } from '../fixtures/files'
import { reasonFor } from '../fixtures/reasons'

const mockedRunProcess = jest.mocked(runProcess)

// A real capture: yarn 4.12.0 (then the repo's packageManager, through Corepack)
// `install` on testRepos/berry-workspace, with packages/b also declaring
// `@autd/a: workspace:*`, `m: npm:ms@^2.0.0` and the devDependency
// `resolve: ^1.22.0` (a builtin patch), 2026-11-03.
const LOCK = 'yarn/berry-workspace.yarn.lock'
const CAPTURED = {
  '.': {
    name: 'autd-berry-workspace',
    private: true,
    packageManager: 'yarn@4.12.0',
    workspaces: ['packages/*'],
    dependencies: { dayjs: '1.11.9', ms: '~2.1.1' },
  },
  'packages/a': {
    name: '@autd/a',
    dependencies: { chalk: '^4.0.0', ms: '2.1.2' },
  },
  'packages/b': {
    name: '@autd/b',
    dependencies: {
      commander: '^11.0.0',
      debug: '~4.3.1',
      '@autd/a': 'workspace:*',
      m: 'npm:ms@^2.0.0',
    },
    devDependencies: { kleur: '~3.0.0', resolve: '^1.22.0' },
  },
}

// When the registry captures were taken, so no version drifts.
const AS_OF = '2026-10-23T16:38:12-03:00'

const commands = (): string[][] =>
  mockedRunProcess.mock.calls.map(([, args]) => args)

describe('yarn berry', () => {
  let cwd: string
  const write = (file: string, content: string | object) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, file),
      typeof content === 'string' ? content : JSON.stringify(content),
    )
  }
  /** The captured workspace; `keep` cuts each manifest to the registry captures' packages. */
  const writeCaptured = (keep?: string[]) => {
    for (const [dir, manifest] of Object.entries(CAPTURED)) {
      const cut = { ...manifest } as Record<string, unknown>
      if (keep) {
        for (const field of ['dependencies', 'devDependencies']) {
          const deps = cut[field] as Record<string, string> | undefined
          if (!deps) continue
          cut[field] = Object.fromEntries(
            Object.entries(deps).filter(([key]) => keep.includes(key)),
          )
        }
      }
      write(path.join(dir, 'package.json'), cut)
    }
    write('yarn.lock', readFixture(LOCK))
  }
  const readJson = (file: string) =>
    JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8'))

  beforeEach(() => {
    cwd = tempDir('autd-berry-')
    // Native discovery (#107): no yarn command runs for check.
    mockedRunProcess.mockRejectedValue(new Error('no yarn command expected'))
  })

  describe('readBerryLock', () => {
    it("reads each workspace's locked version, an alias and a patched package included", () => {
      writeCaptured()
      expect(
        readBerryLock(cwd, [
          { name: 'dayjs', workspace: '.' },
          { name: 'ms', workspace: '.' },
          { name: 'chalk', workspace: 'packages/a' },
          { name: 'ms', workspace: 'packages/a' },
          { name: 'debug', workspace: 'packages/b' },
          { name: 'kleur', workspace: 'packages/b' },
          { name: 'm', workspace: 'packages/b' },
          { name: 'resolve', workspace: 'packages/b' },
          { name: '@autd/a', workspace: 'packages/b' },
        ]),
      ).toEqual({
        '.:dayjs': { version: '1.11.9', linked: false },
        '.:ms': { version: '2.1.3', linked: false },
        'packages/a:chalk': { version: '4.1.2', linked: false },
        'packages/a:ms': { version: '2.1.2', linked: false },
        'packages/b:debug': { version: '4.3.7', linked: false },
        'packages/b:kleur': { version: '3.0.3', linked: false },
        'packages/b:m': { version: '2.1.3', linked: false },
        'packages/b:resolve': { version: '1.22.13', linked: false },
        'packages/b:@autd/a': { version: '', linked: true },
      })
    })

    it('leaves out what the lockfile does not record, and everything without one', () => {
      writeCaptured()
      expect(
        readBerryLock(cwd, [
          { name: 'not-locked', workspace: 'packages/b' },
          { name: 'ms', workspace: 'packages/none' },
        ]),
      ).toEqual({})
      fs.rmSync(path.join(cwd, 'yarn.lock'))
      expect(readBerryLock(cwd, [{ name: 'ms', workspace: '.' }])).toEqual({})
    })
  })

  describe("a target's peers (#198)", () => {
    it("are judged against yarn.lock's versions, from the workspace that declares them", async () => {
      writeCaptured()
      const ms = capturedManifest('ms', '2.1.3', 'ms.2.1.3.manifest')
      const project = projectFor(
        yarn,
        cwd,
        {},
        {
          ...fakeRegistry(),
          versionManifest: async (name, version) =>
            name === 'ms' && version === '2.1.3'
              ? { ...ms, peerDependencies: { chalk: '^5.0.0' } }
              : undefined,
        },
      )

      const results = await plan(project, {
        ms: {
          name: 'ms',
          current: '2.1.2',
          wanted: '2.1.3',
          latest: '2.1.3',
          workspaces: [
            { path: 'packages/a', current: '2.1.2', wanted: '2.1.3' },
          ],
        },
      })

      expect(results).toEqual([
        expect.objectContaining({
          name: 'ms',
          workspace: 'packages/a',
          updated: false,
          // packages/a declares chalk ^4.0.0, which yarn.lock locks at 4.1.2.
          reason: reasonFor(
            'peer conflict: ms@2.1.3 needs chalk ^5.0.0 (installed 4.1.2)',
            'target-peers',
          ),
        }),
      ])
    })
  })

  describe('check', () => {
    const registry = () =>
      capturedRegistry(['dayjs', 'ms', 'debug'], { asOf: AS_OF })

    it('reads yarn.lock and the registry, and runs no yarn command', async () => {
      writeCaptured(['dayjs', 'ms', 'debug', 'm', '@autd/a'])

      const outdated = await check(projectFor(yarn, cwd, {}, registry()))

      expect(mockedRunProcess).not.toHaveBeenCalled()
      // The alias `m` (2.1.3) and the root's ms are up to date; `@autd/a`
      // is a member and never looked up.
      expect(outdated).toEqual({
        dayjs: expect.objectContaining({
          workspaces: [{ path: '.', current: '1.11.9', wanted: '1.11.9' }],
          latest: '1.11.23',
        }),
        debug: expect.objectContaining({
          workspaces: [
            { path: 'packages/b', current: '4.3.7', wanted: '4.3.7' },
          ],
          latest: '4.4.3',
        }),
        ms: expect.objectContaining({
          workspaces: [
            { path: 'packages/a', current: '2.1.2', wanted: '2.1.2' },
          ],
          latest: '2.1.3',
        }),
      })
    })

    it('reads one member alone from a member run (#123)', async () => {
      writeCaptured(['dayjs', 'ms', 'debug', 'm', '@autd/a'])

      const outdated = await check(
        projectFor(yarn, cwd, {}, registry(), {
          path: 'packages/b',
          name: '@autd/b',
        }),
      )

      expect(Object.keys(outdated)).toEqual(['debug'])
      expect(mockedRunProcess).not.toHaveBeenCalled()
    })

    it('resolves a range without preferring the latest tag, as berry does', () => {
      writeCaptured()
      expect(yarn.prefersLatestInRange?.(cwd)).toBe(false)
      write('package.json', {
        ...CAPTURED['.'],
        packageManager: 'yarn@1.22.22',
      })
      fs.rmSync(path.join(cwd, 'yarn.lock'))
      expect(yarn.prefersLatestInRange?.(cwd)).toBe(true)
    })
  })

  describe('update', () => {
    const row = (
      workspace: string,
      name: string,
      current: string,
      wanted: string,
      latest: string,
    ): OutdatedEntry => ({ name, workspace, current, wanted, latest })
    // What discovery found before apply; yarn.lock is the capture, which is
    // what the mocked commands leave.
    const discovered = () =>
      foldWorkspaceEntries([
        row('.', 'dayjs', '1.11.9', '1.11.9', '1.11.23'),
        row('.', 'ms', '2.1.1', '2.1.3', '2.1.3'),
        row('packages/b', 'debug', '4.3.1', '4.3.7', '4.4.3'),
      ])
    const succeed = () =>
      mockedRunProcess.mockResolvedValue({ stdout: '', stderr: '' })

    it('re-resolves in-range packages with `up -R` and checks them in yarn.lock', async () => {
      writeCaptured()
      succeed()

      const results = await update(projectFor(yarn, cwd), {
        discovered: discovered(),
      })

      expect(commands()).toEqual([['up', '-R', 'ms', 'debug']])
      expect(readJson('package.json')).toEqual(CAPTURED['.'])
      expect(
        results.filter((r) => r.updated).map((r) => `${r.workspace}:${r.name}`),
      ).toEqual(['.:ms', 'packages/b:debug'])
    })

    it('writes a spec past its range, installs, and reports what yarn.lock still holds', async () => {
      writeCaptured()
      succeed()

      const results = await update(
        projectFor(yarn, cwd, { beyondRange: 'major' }),
        { discovered: discovered() },
      )

      expect(readJson('packages/b/package.json').dependencies.debug).toBe(
        '~4.4.3',
      )
      expect(readJson('package.json').dependencies.dayjs).toBe('1.11.23')
      expect(commands()).toEqual([
        ['install', '--no-immutable'],
        ['up', '-R', 'ms'],
      ])
      // The mocked install relocked nothing: yarn.lock's debug is 4.3.7.
      expect(results.find((r) => r.name === 'debug')).toMatchObject({
        updated: false,
        reason: reasonFor('not applied by yarn (installed 4.3.7)'),
      })
      expect(results.find((r) => r.name === 'ms')).toMatchObject({
        updated: true,
      })
    })

    it('skips `up` when every package moves past its range', async () => {
      writeCaptured()
      succeed()

      await update(projectFor(yarn, cwd, { beyondRange: 'major' }), {
        discovered: discovered(),
        targetPackages: ['dayjs'],
      })

      expect(commands()).toEqual([['install', '--no-immutable']])
    })

    it('fails apply with the manifest flagged as written when install fails', async () => {
      writeCaptured()
      mockedRunProcess.mockRejectedValue(
        exitError(1, '➤ YN0001: │ Error: install failed', ''),
      )

      await expect(
        update(projectFor(yarn, cwd, { beyondRange: 'major' }), {
          discovered: discovered(),
        }),
      ).rejects.toMatchObject({ step: 'apply', manifestWritten: true })
    })

    it('fails apply without the manifest flagged when `up` fails', async () => {
      writeCaptured()
      mockedRunProcess.mockRejectedValue(
        exitError(1, '➤ YN0001: │ Error: up failed', ''),
      )

      await expect(
        update(projectFor(yarn, cwd), { discovered: discovered() }),
      ).rejects.toMatchObject({ step: 'apply', manifestWritten: false })
    })
  })
})
