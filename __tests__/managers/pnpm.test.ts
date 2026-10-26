import fs from 'fs'
import os from 'os'
import path from 'path'
import pnpm, {
  parsePnpmOutdated,
  parsePnpmWorkspaceOutdated,
} from '@/managers/pnpm'
import { update } from '@/pipeline'
import { StepError } from '@/stepError'
import type { PackageInfo } from '@/types'
import {
  projectFor,
  readFixture,
  WORKSPACE_ENTRIES,
  writeWorkspaceProject,
} from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { runProcess } from '@/utils'

const mockedRunProcess = jest.mocked(runProcess)

describe('pnpm.readWorkspace', () => {
  let cwd: string

  const writeWorkspaceYaml = (content: string) =>
    fs.writeFileSync(path.join(cwd, 'pnpm-workspace.yaml'), content)

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-pnpm-workspace-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('is false without pnpm-workspace.yaml', () => {
    expect(pnpm.readWorkspace(cwd).isWorkspace).toBe(false)
  })

  // Since pnpm 10, settings live in pnpm-workspace.yaml, so a single-package
  // project often has one.
  it.each([
    ['settings only', 'onlyBuiltDependencies: []\n'],
    ['overrides only', 'overrides:\n  dayjs: 1.11.9\n'],
    ['an empty flow list', 'packages: []\n'],
    ['an empty packages key', 'packages:\noverrides:\n  dayjs: 1.11.9\n'],
  ])('is false for a file with %s', (_, yaml) => {
    writeWorkspaceYaml(yaml)
    expect(pnpm.readWorkspace(cwd).isWorkspace).toBe(false)
  })

  it.each([
    ['an indented block list', "packages:\n  - 'packages/*'\n"],
    ['a block list at column 0', 'packages:\n- apps/*\n'],
    ['a block list after a comment', 'packages:\n  # apps\n  - apps/*\n'],
    ['a flow list', "packages: ['packages/*']\n"],
    ['settings around it', 'overrides:\n  ms: 2.1.1\npackages:\n  - a\n'],
  ])('is true for %s of packages', (_, yaml) => {
    writeWorkspaceYaml(yaml)
    expect(pnpm.readWorkspace(cwd).isWorkspace).toBe(true)
  })

  it.each([
    ['no catalog', 'packages:\n  - a\n', {}],
    [
      'the default catalog',
      'catalog:\n  dayjs: 1.11.9\n',
      { default: { dayjs: '1.11.9' } },
    ],
    [
      'named catalogs',
      'catalogs:\n  react18:\n    react: ^18.2.0\n  "legacy":\n    ms: 2.1.1\n',
      { react18: { react: '^18.2.0' }, legacy: { ms: '2.1.1' } },
    ],
    [
      'both',
      'catalog:\n  ms: 2.1.1\ncatalogs:\n    next:\n        react: ^19.0.0\n',
      { default: { ms: '2.1.1' }, next: { react: '^19.0.0' } },
    ],
  ])('lists catalogs for a file with %s', (_, yaml, catalogs) => {
    writeWorkspaceYaml(yaml)
    expect(pnpm.readWorkspace(cwd).catalogs).toEqual(catalogs)
  })

  // Git for Windows can hand out CRLF files; every line reader copes.
  it('reads packages, catalogs and overrides from a CRLF file', () => {
    writeWorkspaceYaml(
      [
        'packages:',
        "  - 'packages/*'",
        '  - apps/*',
        '',
        'catalog:',
        '  ms: ~2.1.1',
        '',
        'catalogs:',
        '  tools:',
        '    debug: ~4.3.1',
        '',
        'overrides:',
        '  ms: 2.1.2',
        '',
      ].join('\r\n'),
    )
    fs.mkdirSync(path.join(cwd, 'packages', 'a'), { recursive: true })
    fs.writeFileSync(path.join(cwd, 'packages', 'a', 'package.json'), '{}')

    const workspace = pnpm.readWorkspace(cwd)

    expect(workspace.isWorkspace).toBe(true)
    expect(workspace.catalogs).toEqual({
      default: { ms: '~2.1.1' },
      tools: { debug: '~4.3.1' },
    })
    expect(workspace.manifests.map((manifest) => manifest.path)).toContain(
      'packages/a',
    )
    expect(pnpm.overrides(cwd)).toEqual({
      ms: {
        field: 'overrides in pnpm-workspace.yaml',
        range: '2.1.2',
      },
    })
  })
})

describe('update with pnpm in a single-package project', () => {
  let cwd: string

  // react ^18.2.0 moves within its range; dayjs moves past its pin.
  const outdated: Record<string, PackageInfo> = {
    react: {
      name: 'react',
      current: '18.2.0',
      wanted: '18.3.1',
      latest: '19.3.1',
    },
    dayjs: {
      name: 'dayjs',
      current: '1.11.9',
      wanted: '1.11.9',
      latest: '1.11.23',
    },
  }

  const write = (file: string, content: string) =>
    fs.writeFileSync(path.join(cwd, file), content)
  const read = (file: string) => fs.readFileSync(path.join(cwd, file), 'utf8')

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-pnpm-single-'))
    mockedRunProcess.mockResolvedValue({ stdout: '', stderr: '' })
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('takes the single-project path when pnpm-workspace.yaml only holds settings', async () => {
    write(
      'package.json',
      JSON.stringify({ dependencies: { react: '^18.2.0', dayjs: '1.11.9' } }),
    )
    write('pnpm-workspace.yaml', 'onlyBuiltDependencies: []\n')

    await update(projectFor(pnpm, cwd, { beyondRange: 'patch' }), {
      discovered: outdated,
    })

    expect(mockedRunProcess.mock.calls.map(([, args]) => args)).toEqual([
      ['update', 'react', 'dayjs'],
    ])
    expect(JSON.parse(read('package.json')).dependencies.dayjs).toBe('1.11.23')
  })

  it('writes a catalog entry without treating the project as a workspace', async () => {
    write(
      'package.json',
      JSON.stringify({ dependencies: { react: '^18.2.0', dayjs: 'catalog:' } }),
    )
    write('pnpm-workspace.yaml', 'catalog:\n  dayjs: 1.11.9\n')

    await update(projectFor(pnpm, cwd, { beyondRange: 'patch' }), {
      discovered: outdated,
    })

    expect(read('pnpm-workspace.yaml')).toBe('catalog:\n  dayjs: 1.11.23\n')
    expect(JSON.parse(read('package.json')).dependencies.dayjs).toBe('catalog:')
    // Not frozen: CI makes a plain `pnpm install` refuse the rewritten catalog.
    expect(mockedRunProcess.mock.calls.map(([, args]) => args)).toEqual([
      ['install', '--no-frozen-lockfile'],
      ['update', 'react'],
    ])
  })
})

describe('parsePnpmOutdated', () => {
  it('takes wanted from the --compatible report', () => {
    const result = parsePnpmOutdated(
      readFixture('pnpm/outdated-ranges.stdout'),
      readFixture('pnpm/outdated-ranges-compatible.stdout'),
    )

    expect(Object.keys(result)).toHaveLength(40)
    expect(result.react).toMatchObject({
      current: '18.2.0',
      wanted: '18.3.1',
      latest: '19.3.1',
    })
    expect(result.dayjs).toMatchObject({ current: '1.11.9', wanted: '1.11.23' })
    // An exact pin has no compatible update.
    expect(result.minimist).toMatchObject({ current: '1.2.7', wanted: '1.2.7' })
  })

  it("keeps pnpm's own wanted for a package the compatible report omits", () => {
    const result = parsePnpmOutdated(
      readFixture('pnpm/outdated-ranges.stdout'),
      '',
    )

    expect(result.react.wanted).toBe('18.2.0')
  })
})

describe('parsePnpmWorkspaceOutdated', () => {
  const report = readFixture('pnpm/outdated-workspace.stdout')
  const compatible = readFixture('pnpm/outdated-workspace-compatible.stdout')

  it('parses one entry per dependent package, wanted from --compatible', () => {
    const entries = parsePnpmWorkspaceOutdated(report, compatible, '/project')

    expect(entries).toHaveLength(5)
    expect(entries).toEqual(expect.arrayContaining(WORKSPACE_ENTRIES))
  })

  it('strips the @current suffix pnpm adds to a name at several versions', () => {
    expect(JSON.parse(report)).toHaveProperty(['ms@2.1.1'])

    const entries = parsePnpmWorkspaceOutdated(report, compatible, '/project')

    expect(entries.map((e) => e.name)).not.toContain('ms@2.1.1')
    expect(entries.map((e) => e.name)).not.toContain('ms@2.1.2')
  })

  it('fails discovery for a location outside the project', () => {
    expect(() =>
      parsePnpmWorkspaceOutdated(report, compatible, '/elsewhere'),
    ).toThrow(StepError)
  })

  it('fails discovery for a row that names no dependent packages', () => {
    // Dropping it would read as "up to date".
    const parsed = JSON.parse(report)
    delete parsed.debug.dependentPackages

    expect(() =>
      parsePnpmWorkspaceOutdated(
        JSON.stringify(parsed),
        compatible,
        '/project',
      ),
    ).toThrow('pnpm outdated -r reported debug with no dependentPackages')
  })
})

describe('pnpm.readWorkspace manifests', () => {
  it('lists the root, then the members the patterns match', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-pnpm-manifests-'))
    try {
      writeWorkspaceProject(cwd, { pnpm: true })

      expect(pnpm.readWorkspace(cwd).manifests).toEqual([
        { path: '.', name: 'ws-root' },
        { path: 'packages/a', name: '@ws/a' },
        { path: 'packages/b', name: '@ws/b' },
      ])
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })

  it('reads quoted block items and flow lists', () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-pnpm-manifests-'))
    try {
      writeWorkspaceProject(cwd, { pnpm: true })
      fs.writeFileSync(
        path.join(cwd, 'pnpm-workspace.yaml'),
        'packages: [\'packages/a\', "packages/b"] # members\n',
      )

      expect(pnpm.readWorkspace(cwd)).toMatchObject({
        isWorkspace: true,
        manifests: [
          { path: '.' },
          { path: 'packages/a' },
          { path: 'packages/b' },
        ],
      })
    } finally {
      fs.rmSync(cwd, { recursive: true, force: true })
    }
  })
})
