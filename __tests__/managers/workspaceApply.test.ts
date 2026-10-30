import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm from '@/managers/pnpm'
import yarn from '@/managers/yarn'
import { update } from '@/pipeline'
import type { PackageInfo } from '@/types'
import {
  capturedRegistry,
  exitError,
  installPackages,
  isolateNpmConfig,
  projectFor,
  writeWorkspaceProject,
} from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { runProcess } from '@/utils'

const mockedRunProcess = jest.mocked(runProcess)

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

// When the workspace fixtures were captured, so no version drifts with the registry.
const AS_OF = '2026-10-23T16:38:12-03:00'

describe.each([
  {
    pm: 'npm',
    adapter: npm,
    pnpm: false,
    inRange: [['update', 'dayjs', 'debug', 'ms']],
    beyond: [['update', 'dayjs', 'debug', 'ms']],
    writesManifests: true,
    flagsFirstFailure: true,
  },
  {
    pm: 'pnpm',
    adapter: pnpm,
    pnpm: true,
    inRange: [['update', '-r', 'dayjs', 'debug', 'ms']],
    beyond: [
      ['install', '--no-frozen-lockfile'],
      ['update', '-r', 'dayjs', 'debug', 'ms'],
    ],
    writesManifests: true,
    flagsFirstFailure: true,
  },
  {
    pm: 'yarn',
    adapter: yarn,
    pnpm: false,
    inRange: [
      ['upgrade', 'ms@~2.1.1'],
      ['workspace', '@ws/b', 'upgrade', 'dayjs@^1.11.9', 'debug@~4.3.1'],
      ['install', '--check-files'],
    ],
    beyond: [
      ['upgrade', 'ms@~2.1.1', 'dayjs@1.11.23'],
      ['workspace', '@ws/a', 'upgrade', 'ms@2.1.3'],
      ['workspace', '@ws/b', 'upgrade', 'dayjs@^1.11.9', 'debug@~4.3.1'],
      ['install', '--check-files'],
    ],
    // yarn's first command runs before autd writes anything.
    writesManifests: true,
    flagsFirstFailure: false,
  },
  {
    pm: 'bun',
    adapter: bun,
    pnpm: false,
    inRange: [['update', 'dayjs', 'debug', 'ms', '--filter', '*']],
    beyond: [['update', 'dayjs', 'debug', 'ms', '--filter', '*']],
    writesManifests: true,
    flagsFirstFailure: true,
  },
] as const)(
  'workspace apply with $pm',
  ({
    pm,
    adapter,
    pnpm: usesPnpm,
    inRange,
    beyond,
    writesManifests,
    flagsFirstFailure,
  }) => {
    let cwd: string

    const readJson = (file: string) =>
      JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8'))
    const commands = () => mockedRunProcess.mock.calls.map(([, args]) => args)

    // Every command succeeds, or fails with applyError.
    const answerCommands = (applyError?: Error) =>
      mockedRunProcess.mockImplementation(async () => {
        if (applyError) throw applyError
        return { stdout: '', stderr: '' }
      })

    // The evidence workspace as its install left it.
    const registry = () =>
      capturedRegistry(['dayjs', 'ms', 'debug'], { asOf: AS_OF })

    beforeEach(() => {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), `autd-ws-apply-${pm}-`))
      writeWorkspaceProject(cwd, { pnpm: usesPnpm })
      installPackages(cwd, '.', {
        dayjs: '1.11.9',
        ms: '2.1.1',
        debug: '4.3.1',
      })
      installPackages(cwd, 'packages/a', { ms: '2.1.2' })
      answerCommands()
    })

    afterEach(() => {
      fs.rmSync(cwd, { recursive: true, force: true })
    })

    it('updates every manifest in range with the manager, writing nothing itself', async () => {
      await update(projectFor(adapter, cwd, {}, registry()))

      expect(commands()).toEqual(inRange)
      expect(readJson('package.json').dependencies).toEqual({
        dayjs: '1.11.9',
        ms: '~2.1.1',
      })
      expect(readJson('packages/a/package.json').dependencies).toEqual({
        ms: '2.1.2',
      })
      expect(readJson('packages/b/package.json').dependencies).toEqual({
        debug: '~4.3.1',
        dayjs: '^1.11.9',
      })
    })

    it('moves a pin past its range in the manifest that owns it', async () => {
      await update(
        projectFor(adapter, cwd, { beyondRange: 'patch' }, registry()),
      )

      expect(commands()).toEqual(beyond)
      // yarn writes the root's spec itself, which the mocked command does not.
      const expectedRoot =
        writesManifests && pm !== 'yarn' ? '1.11.23' : '1.11.9'
      const expectedA = writesManifests ? '2.1.3' : '2.1.2'
      expect(readJson('package.json').dependencies).toEqual({
        dayjs: expectedRoot,
        ms: '~2.1.1',
      })
      expect(readJson('packages/a/package.json').dependencies).toEqual({
        ms: expectedA,
      })
      expect(readJson('packages/b/package.json').dependencies).toEqual({
        debug: '~4.3.1',
        dayjs: '^1.11.9',
      })
    })

    it('flags the written manifests when a command fails after the writes', async () => {
      answerCommands(exitError(1, '', 'boom'))

      const error = await update(
        projectFor(adapter, cwd, { beyondRange: 'patch' }, registry()),
      ).catch((e: unknown) => e)

      expect(error).toMatchObject({
        step: 'apply',
        manifestWritten: flagsFirstFailure,
      })
    })
  },
)

describe('yarn v1 workspace apply', () => {
  it('fails when a member that must move has no name', async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-ws-apply-yarn-'))
    try {
      writeWorkspaceProject(cwd)
      fs.writeFileSync(
        path.join(cwd, 'packages/b/package.json'),
        JSON.stringify({
          version: '1.0.0',
          dependencies: { debug: '~4.3.1', dayjs: '^1.11.9' },
        }),
      )
      const discovered: Record<string, PackageInfo> = {
        debug: {
          name: 'debug',
          current: '4.3.1',
          wanted: '4.3.7',
          latest: '4.4.3',
          workspaces: [
            { path: 'packages/b', current: '4.3.1', wanted: '4.3.7' },
          ],
        },
      }
      mockedRunProcess.mockResolvedValue({ stdout: '', stderr: '' })

      await expect(
        update(projectFor(yarn, cwd), { discovered }),
      ).rejects.toMatchObject({ step: 'apply' })
      expect(mockedRunProcess).not.toHaveBeenCalled()
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})

// A catalog entry and a direct spec of the same package, in different manifests.
const dayjs: PackageInfo = {
  name: 'dayjs',
  current: '1.11.9',
  wanted: '1.11.9',
  latest: '1.11.23',
  workspaces: [
    { path: '.', current: '1.11.9', wanted: '1.11.9' },
    { path: 'packages/b', current: '1.11.9', wanted: '1.11.9' },
  ],
}

describe.each([
  { pm: 'pnpm', adapter: pnpm },
  { pm: 'bun', adapter: bun },
] as const)('catalog routing with $pm', ({ pm, adapter }) => {
  let cwd: string

  const read = (file: string) => fs.readFileSync(path.join(cwd, file), 'utf8')
  const readJson = (file: string) => JSON.parse(read(file))

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), `autd-ws-catalog-${pm}-`))
    writeWorkspaceProject(cwd, { pnpm: pm === 'pnpm' })
    const root = readJson('package.json')
    if (pm === 'pnpm') {
      fs.writeFileSync(
        path.join(cwd, 'pnpm-workspace.yaml'),
        'packages:\n  - packages/*\ncatalog:\n  dayjs: 1.11.9\n',
      )
    } else {
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({ ...root, catalog: { dayjs: '1.11.9' } }),
      )
    }
    fs.writeFileSync(
      path.join(cwd, 'packages/b/package.json'),
      JSON.stringify({
        name: '@ws/b',
        version: '1.0.0',
        dependencies: { dayjs: 'catalog:' },
      }),
    )
    mockedRunProcess.mockResolvedValue({ stdout: '', stderr: '' })
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('writes the catalog for a catalog: spec and the owning manifest for a direct one', async () => {
    await update(projectFor(adapter, cwd, { beyondRange: 'patch' }), {
      discovered: { dayjs },
    })

    expect(readJson('packages/b/package.json').dependencies.dayjs).toBe(
      'catalog:',
    )
    expect(readJson('package.json').dependencies.dayjs).toBe('1.11.23')
    if (pm === 'pnpm') {
      expect(read('pnpm-workspace.yaml')).toContain('dayjs: 1.11.23')
    } else {
      expect(readJson('package.json').catalog.dayjs).toBe('1.11.23')
    }
    expect(mockedRunProcess.mock.calls.map(([, args]) => args)).toEqual([
      pm === 'pnpm' ? ['install', '--no-frozen-lockfile'] : ['install'],
    ])
  })
})
