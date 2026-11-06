jest.mock('@/utils/logger')

import fs from 'fs'
import os from 'os'
import path from 'path'
import { bunReleaseAgeGate } from '@/managers/bun/bunfig'
import { npmReleaseAgeGate } from '@/managers/npm'
import { pnpmReleaseAgeGate } from '@/managers/pnpm/releaseAge'
import { check } from '@/pipeline'
import { openProject, type Project } from '@/project'
import type { SupportedPackageManager } from '@/types'
import type { NpmrcSources } from '@/utils/npmrcLoader'
import { installPackages, isolateNpmConfig } from './fixtures'
import { startRegistry, type TestRegistry } from './fixtures/registry'

// #168: each manager's release-age gate, a security setting autd never
// overrides. Probed 2026-11-03 on pnpm 12.16.1 (p-rows), bun 1.4.4 (b-rows)
// and npm 12.2.1 (n-rows), each with its own install against a local
// registry with set publish times.

let tmp: string
const at = (...parts: string[]) => path.join(tmp, ...parts)
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}
const sourcesFor = (env: NodeJS.ProcessEnv = {}): NpmrcSources => ({
  env,
  home: at('home'),
  execPath: at('prefix', 'bin', 'node'),
  platform: process.platform,
})

beforeEach(() => {
  tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autd-age-')))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('pnpmReleaseAgeGate', () => {
  const xdg = (env: NodeJS.ProcessEnv = {}) =>
    sourcesFor({ XDG_CONFIG_HOME: at('xdg'), ...env })

  it('is one day with nothing set (p01)', () => {
    expect(pnpmReleaseAgeGate(tmp, xdg())).toEqual({
      setting: 'minimumReleaseAge',
      minutes: 1440,
      scopes: {},
      exempt: [],
      missingTime: 'allowed',
    })
  })

  it('reads the env, then pnpm-workspace.yaml, then the global config.yaml (p10, p13, p14)', () => {
    write(at('xdg', 'pnpm', 'config.yaml'), 'minimumReleaseAge: 30\n')
    expect(pnpmReleaseAgeGate(tmp, xdg()).minutes).toBe(30)
    write(at('pnpm-workspace.yaml'), 'minimumReleaseAge: 60\n')
    expect(pnpmReleaseAgeGate(tmp, xdg()).minutes).toBe(60)
    expect(
      pnpmReleaseAgeGate(tmp, xdg({ pnpm_config_minimum_release_age: '90' }))
        .minutes,
    ).toBe(90)
    write(at('pnpm-workspace.yaml'), 'minimumReleaseAge: 0\n')
    expect(pnpmReleaseAgeGate(tmp, xdg()).minutes).toBe(0)
  })

  it('reads minimumReleaseAgeExclude with exact versions, and a missing time held only when told (p02-p05, p17, p19)', () => {
    write(
      at('pnpm-workspace.yaml'),
      [
        'minimumReleaseAgeExclude:',
        "  - 'p-*'",
        '  - p-fresh@1.0.1 || 1.0.2',
        'minimumReleaseAgeIgnoreMissingTime: false',
      ].join('\n'),
    )
    expect(pnpmReleaseAgeGate(tmp, xdg())).toMatchObject({
      exempt: [
        { name: 'p-*', glob: 'any' },
        { name: 'p-fresh', glob: 'any', versions: '1.0.1 || 1.0.2' },
      ],
      missingTime: 'held',
    })
  })
})

describe('bunReleaseAgeGate', () => {
  const xdg = () => sourcesFor({ XDG_CONFIG_HOME: at('xdg') })
  beforeEach(() => write(at('package.json'), '{"name":"p"}'))

  it('is off with nothing set (b01)', () => {
    expect(bunReleaseAgeGate(tmp, xdg())).toBeUndefined()
  })

  it('reads seconds from the project bunfig.toml, else the global one (b02, b10)', () => {
    write(at('xdg', '.bunfig.toml'), '[install]\nminimumReleaseAge = 600\n')
    expect(bunReleaseAgeGate(tmp, xdg())?.minutes).toBe(10)
    write(at('bunfig.toml'), '[install]\nminimumReleaseAge = 3600 # an hour\n')
    expect(bunReleaseAgeGate(tmp, xdg())?.minutes).toBe(60)
  })

  it('reads exact names with an optional version, in one line or several (b03, b09, b11)', () => {
    write(
      at('bunfig.toml'),
      '[install]\nminimumReleaseAge = 86400\nminimumReleaseAgeExcludes = [\n  "p-fresh@1.0.1",\n  "@acme/probe", # a comment\n]\n',
    )
    expect(bunReleaseAgeGate(tmp, xdg())?.exempt).toEqual([
      { name: 'p-fresh', glob: 'none', versions: '1.0.1' },
      { name: '@acme/probe', glob: 'none' },
    ])
  })
})

describe('npmReleaseAgeGate', () => {
  it('is off with nothing set (n01)', () => {
    expect(npmReleaseAgeGate({})).toBeUndefined()
  })

  it('reads min-release-age in days, its excludes, and before (n02, n03, n10, n11)', () => {
    expect(
      npmReleaseAgeGate({
        'min-release-age': '0.5',
        'min-release-age-exclude': ['p-*', 'p-fresh@1.0.2'],
        before: '2026-11-03T10:00:00Z',
      }),
    ).toEqual({
      setting: 'min-release-age',
      minutes: 720,
      scopes: {},
      exempt: [
        { name: 'p-*', glob: 'segment' },
        { name: 'p-fresh@1.0.2', glob: 'segment' },
      ],
      missingTime: 'allowed',
      notAfter: '2026-11-03T10:00:00.000Z',
    })
    expect(npmReleaseAgeGate({ before: '2026-11-03' })?.setting).toBe('before')
  })
})

// The real openProject, session and discovery against a local registry:
// probe 1.0.0 and 1.0.1 are old, 1.0.2 came out an hour ago. Before #168
// autd proposed 1.0.2 wherever the manager gates it.
describe('check under each manager’s gate', () => {
  let server: TestRegistry
  let saved: NodeJS.ProcessEnv
  let restoreNpm: () => void
  const projects: Project[] = []

  beforeEach(async () => {
    saved = { ...process.env }
    process.env.HOME = at('home')
    process.env.XDG_CONFIG_HOME = at('xdg')
    process.env.PREFIX = at('prefix')
    restoreNpm = isolateNpmConfig(at('npm-config'))
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString()
    server = await startRegistry((req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          name: 'probe',
          'dist-tags': { latest: '1.0.2' },
          versions: Object.fromEntries(
            ['1.0.0', '1.0.1', '1.0.2'].map((v) => [
              v,
              { name: 'probe', version: v },
            ]),
          ),
          time: {
            '1.0.0': '2020-01-01T00:00:00.000Z',
            '1.0.1': '2020-02-01T00:00:00.000Z',
            '1.0.2': hourAgo,
          },
        }),
      )
      void req
    })
    write(at('package.json'), '{"name":"p","dependencies":{"probe":"^1.0.0"}}')
    installPackages(tmp, '.', { probe: '1.0.0' })
  })
  afterEach(async () => {
    for (const project of projects.splice(0)) project.registry.close()
    await server.close()
    restoreNpm()
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
  })

  const wantedWith = async (
    pm: SupportedPackageManager,
    files: Record<string, string>,
  ) => {
    for (const [file, content] of Object.entries(files)) {
      write(at(file), content.replaceAll('REGISTRY', server.url))
    }
    const project = openProject(tmp, { pm, cache: false })
    projects.push(project)
    const outdated = await check(project)
    return { wanted: outdated.probe?.wanted, latest: outdated.probe?.latest }
  }

  it.each([
    [
      'pnpm',
      'its one-day default (p01)',
      { '.npmrc': 'registry=REGISTRY\n' },
      '1.0.1',
    ],
    [
      'pnpm',
      'minimumReleaseAge: 0 (p12)',
      {
        '.npmrc': 'registry=REGISTRY\n',
        'pnpm-workspace.yaml': 'minimumReleaseAge: 0\n',
      },
      '1.0.2',
    ],
    ['npm', 'nothing set (n01)', { '.npmrc': 'registry=REGISTRY\n' }, '1.0.2'],
    [
      'npm',
      'min-release-age=1 (n02)',
      { '.npmrc': 'registry=REGISTRY\nmin-release-age=1\n' },
      '1.0.1',
    ],
    [
      'bun',
      'nothing set (b01)',
      { 'bunfig.toml': '[install]\nregistry = "REGISTRY"\n' },
      '1.0.2',
    ],
    [
      'bun',
      'minimumReleaseAge = 86400 (b02)',
      {
        'bunfig.toml':
          '[install]\nregistry = "REGISTRY"\nminimumReleaseAge = 86400\n',
      },
      '1.0.1',
    ],
  ] as const)('%s with %s proposes %s', async (pm, _label, files, expected) => {
    expect(await wantedWith(pm, files)).toEqual({
      wanted: expected,
      latest: expected,
    })
  })

  // #177: a packument's `modified` skips the publish-time read only on the
  // public npm registries. This registry (not one) serves an abbreviated
  // document with a long-past `modified`, and a full one whose `time` makes
  // 1.0.2 an hour old: the gate must still hold 1.0.2.
  it('does not trust a modified from a registry that is not public npm (#177)', async () => {
    await server.close()
    const hourAgo = new Date(Date.now() - 60 * 60_000).toISOString()
    const versions = Object.fromEntries(
      ['1.0.0', '1.0.1', '1.0.2'].map((v) => [
        v,
        { name: 'probe', version: v },
      ]),
    )
    server = await startRegistry((req, res) => {
      res.setHeader('content-type', 'application/json')
      const abbreviated = String(req.headers.accept).includes('install-v1')
      res.end(
        JSON.stringify({
          name: 'probe',
          'dist-tags': { latest: '1.0.2' },
          versions,
          ...(abbreviated
            ? { modified: '2020-03-01T00:00:00.000Z' }
            : {
                time: {
                  '1.0.0': '2020-01-01T00:00:00.000Z',
                  '1.0.1': '2020-02-01T00:00:00.000Z',
                  '1.0.2': hourAgo,
                },
              }),
        }),
      )
    })

    expect(
      await wantedWith('pnpm', { '.npmrc': 'registry=REGISTRY\n' }),
    ).toEqual({ wanted: '1.0.1', latest: '1.0.1' })
  })
})
