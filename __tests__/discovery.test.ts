import fs from 'fs'
import os from 'os'
import path from 'path'
import { discoverFromRegistry } from '@/discovery'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm from '@/managers/pnpm'
import yarn from '@/managers/yarn'
import { check, plan } from '@/pipeline'
import { StepError } from '@/stepError'
import type { PackageLookup } from '@/types'
import {
  capturedPackage,
  capturedRegistry,
  fakeRegistry,
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

const mockedRunProcess = jest.mocked(runProcess)

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
  cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-discovery-'))
})

afterEach(() => {
  fs.rmSync(cwd, { recursive: true, force: true })
})

const writeJson = (file: string, content: object): void => {
  fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
  fs.writeFileSync(path.join(cwd, file), JSON.stringify(content))
}

const discover = (
  registry: ReturnType<typeof capturedRegistry>,
  adapter: typeof npm = npm,
) =>
  discoverFromRegistry({
    cwd,
    manager: adapter.name,
    workspace: adapter.readWorkspace(cwd),
    registry,
  })

describe.each(ADAPTERS)('check with $pm', ({ adapter }) => {
  it('starts no process', async () => {
    writeWorkspaceProject(cwd, { pnpm: adapter.name === 'pnpm' })
    installPackages(cwd, '.', { dayjs: '1.11.9', ms: '2.1.1', debug: '4.3.1' })
    installPackages(cwd, 'packages/a', { ms: '2.1.2' })

    const outdated = await check(
      projectFor(
        adapter,
        cwd,
        {},
        capturedRegistry(['dayjs', 'ms', 'debug'], { asOf: AS_OF }),
      ),
    )

    expect(Object.keys(outdated)).toEqual(['dayjs', 'debug', 'ms'])
    expect(mockedRunProcess).not.toHaveBeenCalled()
  })
})

describe('discoverFromRegistry', () => {
  it('returns a single-package project as a record keyed by name', async () => {
    writeJson('package.json', {
      dependencies: { ms: '2.1.1', dayjs: '1.11.9' },
    })
    installPackages(cwd, '.', { ms: '2.1.1', dayjs: '1.11.9' })

    const discovery = await discover(
      capturedRegistry(['ms', 'dayjs'], { asOf: AS_OF }),
    )

    expect(discovery).toEqual({
      kind: 'single',
      outdated: {
        dayjs: {
          name: 'dayjs',
          current: '1.11.9',
          wanted: '1.11.9',
          latest: '1.11.23',
        },
        ms: { name: 'ms', current: '2.1.1', wanted: '2.1.1', latest: '2.1.3' },
      },
    })
    // The key order the JSON snapshot depends on.
    expect(
      Object.keys(discovery.kind === 'single' ? discovery.outdated.ms : {}),
    ).toEqual(['name', 'current', 'wanted', 'latest'])
  })

  it('orders a workspace by name, then the root first, then by path', async () => {
    writeWorkspaceProject(cwd)
    installPackages(cwd, '.', { dayjs: '1.11.9', ms: '2.1.1', debug: '4.3.1' })
    installPackages(cwd, 'packages/a', { ms: '2.1.2' })

    const discovery = await discover(
      capturedRegistry(['dayjs', 'ms', 'debug'], { asOf: AS_OF }),
    )

    expect(
      discovery.kind === 'workspace' &&
        discovery.entries.map((entry) => [entry.name, entry.workspace]),
    ).toEqual([
      ['dayjs', '.'],
      ['dayjs', 'packages/b'],
      ['debug', 'packages/b'],
      ['ms', '.'],
      ['ms', 'packages/a'],
    ])
  })

  it('asks the registry once per unique name', async () => {
    writeWorkspaceProject(cwd)
    installPackages(cwd, '.', { dayjs: '1.11.9', ms: '2.1.1', debug: '4.3.1' })
    const registry = capturedRegistry(['dayjs', 'ms', 'debug'], { asOf: AS_OF })
    const lookup = jest.fn(registry.lookup)

    await discover({ ...registry, lookup })

    expect(lookup.mock.calls.map(([name]) => name).sort()).toEqual([
      'dayjs',
      'debug',
      'ms',
    ])
  })

  it('never looks up a spec that does not come from the registry', async () => {
    writeJson('package.json', {
      dependencies: {
        dayjs: '1.11.9',
        a: 'github:owner/repo',
        b: 'workspace:*',
        c: 'link:../c',
        d: 'file:../d',
        e: 'next',
        f: 'https://example.com/f.tgz',
      },
    })
    installPackages(cwd, '.', { dayjs: '1.11.9' })

    // capturedRegistry throws for any name it was not told to expect.
    const discovery = await discover(
      capturedRegistry(['dayjs'], { asOf: AS_OF }),
    )

    expect(
      discovery.kind === 'single' && Object.keys(discovery.outdated),
    ).toEqual(['dayjs'])
    // `next` is another dist-tag: it would read as up to date, so it warns.
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('e'))
  })

  it('skips a workspace member linked into node_modules, without a lookup', async () => {
    writeWorkspaceProject(cwd)
    writeJson('packages/a/package.json', { name: '@ws/a', version: '1.0.0' })
    writeJson('packages/b/package.json', {
      name: '@ws/b',
      version: '1.0.0',
      dependencies: { '@ws/a': '^1.0.0', dayjs: '^1.11.9' },
    })
    installPackages(cwd, '.', { dayjs: '1.11.9', ms: '2.1.1' })
    fs.mkdirSync(path.join(cwd, 'node_modules', '@ws'), { recursive: true })
    fs.symlinkSync(
      path.join(cwd, 'packages', 'a'),
      path.join(cwd, 'node_modules', '@ws', 'a'),
      'junction',
    )

    const discovery = await discover(
      capturedRegistry(['dayjs', 'ms'], { asOf: AS_OF }),
    )

    expect(
      discovery.kind === 'workspace' &&
        discovery.entries.some((entry) => entry.name === '@ws/a'),
    ).toBe(false)
  })

  it('skips a member that is not installed either', async () => {
    writeWorkspaceProject(cwd)
    writeJson('packages/b/package.json', {
      name: '@ws/b',
      dependencies: { '@ws/a': '*' },
    })
    installPackages(cwd, '.', { dayjs: '1.11.9', ms: '2.1.1' })

    const discovery = await discover(
      capturedRegistry(['dayjs', 'ms'], { asOf: AS_OF }),
    )

    expect(
      discovery.kind === 'workspace' &&
        discovery.entries.some((entry) => entry.name === '@ws/a'),
    ).toBe(false)
  })

  it('reports a dependency that is not installed as missing, and skips a missing optional one', async () => {
    writeJson('package.json', {
      dependencies: { dayjs: '^1.11.9', ms: '2.1.3' },
      optionalDependencies: { debug: '^4.3.1' },
    })
    installPackages(cwd, '.', { dayjs: '1.11.9' })

    const discovery = await discover(
      capturedRegistry(['dayjs', 'ms'], { asOf: AS_OF }),
    )

    expect(discovery.kind === 'single' && discovery.outdated.ms).toEqual({
      name: 'ms',
      current: 'missing',
      wanted: '2.1.3',
      latest: '2.1.3',
    })
    expect(discovery.kind === 'single' && 'debug' in discovery.outdated).toBe(
      false,
    )
  })

  it('fails with the install command when there is no node_modules', async () => {
    writeJson('package.json', { dependencies: { dayjs: '1.11.9' } })

    const error = await discover(capturedRegistry([]), pnpm).catch(
      (e: unknown) => e,
    )

    expect(error).toBeInstanceOf(StepError)
    expect(error).toMatchObject({ step: 'discover' })
    expect((error as Error).message).toContain('`pnpm install`')
  })

  it('needs no node_modules when nothing comes from the registry', async () => {
    writeJson('package.json', { dependencies: { a: 'github:owner/repo' } })

    await expect(discover(capturedRegistry([]))).resolves.toEqual({
      kind: 'single',
      outdated: {},
    })
  })

  it('reads a pnpm-workspace.yaml of settings only as a single-package project', async () => {
    writeJson('package.json', { dependencies: { dayjs: '1.11.9' } })
    fs.writeFileSync(
      path.join(cwd, 'pnpm-workspace.yaml'),
      'onlyBuiltDependencies: []\n',
    )
    installPackages(cwd, '.', { dayjs: '1.11.9' })

    const discovery = await discover(
      capturedRegistry(['dayjs'], { asOf: AS_OF }),
      pnpm,
    )

    expect(discovery.kind).toBe('single')
  })

  describe('failed lookups', () => {
    const failure = (name: string, reason: string): PackageLookup => ({
      ok: false,
      name,
      kind: 'request',
      reason,
    })

    it('fail the run once, naming each package, after the other lookups settled', async () => {
      writeJson('package.json', {
        dependencies: { dayjs: '1.11.9', ms: '2.1.1', debug: '4.3.1' },
      })
      installPackages(cwd, '.', {
        dayjs: '1.11.9',
        ms: '2.1.1',
        debug: '4.3.1',
      })
      let slowSettled = false
      const registry = fakeRegistry({
        lookup: async (name) => {
          if (name === 'ms') return failure(name, 'registry unreachable')
          if (name === 'debug') return failure(name, 'HTTP 503')
          await new Promise((resolve) => setTimeout(resolve, 20))
          slowSettled = true
          return { ok: true, package: capturedPackage(name, { asOf: AS_OF }) }
        },
      })

      const error = await discover(registry).catch((e: unknown) => e)

      expect(slowSettled).toBe(true)
      expect(error).toBeInstanceOf(StepError)
      expect(error).toMatchObject({ step: 'discover' })
      expect((error as Error).message).toContain('debug: HTTP 503')
      expect((error as Error).message).toContain('ms: registry unreachable')
    })

    it('name the first ten, then count the rest', async () => {
      const names = Array.from({ length: 12 }, (_, i) => `pkg-${i}`)
      writeJson('package.json', {
        dependencies: Object.fromEntries(names.map((n) => [n, '^1.0.0'])),
      })
      installPackages(
        cwd,
        '.',
        Object.fromEntries(names.map((n) => [n, '1.0.0'])),
      )

      const error = await discover(
        fakeRegistry({ lookup: async (name) => failure(name, 'HTTP 404') }),
      ).catch((e: unknown) => e)

      const lines = (error as Error).message.split('\n')
      expect(lines.filter((line) => line.includes('HTTP 404'))).toHaveLength(10)
      expect(lines.at(-1)).toBe('  and 2 more')
    })
  })
})

// #95: rows that shared a version shared a `wanted`.
describe('a pnpm workspace whose manifests share an installed version', () => {
  it('computes wanted from each manifest range', async () => {
    writeJson('package.json', {
      name: 'root',
      private: true,
      dependencies: { dayjs: '~1.10.0' },
    })
    fs.writeFileSync(
      path.join(cwd, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\n',
    )
    writeJson('packages/m/package.json', {
      name: '@ws/m',
      dependencies: { dayjs: '^1.10.0' },
    })
    installPackages(cwd, '.', { dayjs: '1.10.0' })
    const registry = capturedRegistry(['dayjs'])
    const { latest } = capturedPackage('dayjs')
    // Guards the fixture: the two ranges must disagree.
    expect(latest).not.toBe('1.10.8')

    const project = projectFor(pnpm, cwd, { beyondRange: 'minor' }, registry)
    const outdated = await check(project)

    expect(outdated.dayjs.workspaces).toEqual([
      { path: '.', current: '1.10.0', wanted: '1.10.8' },
      { path: 'packages/m', current: '1.10.0', wanted: latest },
    ])

    // packages/m moves in range, so no spec is rewritten.
    const results = await plan(project, outdated)
    const member = results.find((r) => r.workspace === 'packages/m')
    expect(member?.target).toBe(member?.wanted)
  })
})
