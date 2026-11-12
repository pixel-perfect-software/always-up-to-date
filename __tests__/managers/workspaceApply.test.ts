import fs from 'fs'
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
jest.mock('@/utils/runProcess', () => ({
  ...jest.requireActual('@/utils/runProcess'),
  runProcess: jest.fn(),
}))

import { runProcess } from '@/utils/runProcess'
import { tempDir } from '../fixtures/files'

const mockedRunProcess = jest.mocked(runProcess)

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
    // #127: a package moving in a member is pinned and moves with two root
    // installs (the pin, then the relocked range); the root's own moves keep
    // `yarn upgrade`. Never `workspace <name> upgrade`.
    pm: 'yarn',
    adapter: yarn,
    pnpm: false,
    inRange: [['install'], ['install'], ['upgrade', 'ms@~2.1.1']],
    beyond: [['install'], ['install']],
    writesManifests: true,
    flagsFirstFailure: true,
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
      cwd = tempDir(`autd-ws-apply-${pm}-`)
      writeWorkspaceProject(cwd, { pnpm: usesPnpm })
      installPackages(cwd, '.', {
        dayjs: '1.11.9',
        ms: '2.1.1',
        debug: '4.3.1',
      })
      installPackages(cwd, 'packages/a', { ms: '2.1.2' })
      // What yarn's install of the pinned versions leaves, for the relock.
      if (pm === 'yarn') {
        fs.writeFileSync(
          path.join(cwd, 'yarn.lock'),
          ['dayjs@1.11.23', 'debug@4.3.7', 'ms@2.1.3']
            .map((key) => `${key}:\n  version "${key.split('@')[1]}"\n`)
            .join('\n'),
        )
      }
      answerCommands()
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
      const expectedRoot = writesManifests ? '1.11.23' : '1.11.9'
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
  // #127: a member's move resolves with root installs, which need no
  // workspace name (`workspace <name> upgrade` did).
  it('moves a member that has no name', async () => {
    const cwd = tempDir('autd-ws-apply-yarn-')
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
        workspaces: [{ path: 'packages/b', current: '4.3.1', wanted: '4.3.7' }],
      },
    }
    fs.writeFileSync(
      path.join(cwd, 'yarn.lock'),
      'debug@4.3.7:\n  version "4.3.7"\n',
    )
    mockedRunProcess.mockResolvedValue({ stdout: '', stderr: '' })

    await update(projectFor(yarn, cwd), { discovered })
    expect(mockedRunProcess.mock.calls.map(([, args]) => args)).toEqual([
      ['install'],
      ['install'],
    ])
    expect(fs.readFileSync(path.join(cwd, 'yarn.lock'), 'utf8')).toContain(
      'debug@4.3.7, debug@~4.3.1:',
    )
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
    cwd = tempDir(`autd-ws-catalog-${pm}-`)
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
