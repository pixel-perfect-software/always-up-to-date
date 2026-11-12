import fs from 'fs'
import path from 'path'
import pnpm from '@/managers/pnpm'
import { pnpmNpmrcLayers } from '@/managers/pnpm/npmrc'
import { pnpmRegistrySettings } from '@/managers/pnpm/registries'
import { pnpmReleaseAgeGate } from '@/managers/pnpm/releaseAge'
import {
  parsePnpmYaml,
  pnpmCatalogs,
  pnpmOverrides,
  pnpmPackages,
  pnpmSetting,
  readPnpmWorkspaceYaml,
} from '@/managers/pnpm/workspaceYaml'
import { pnpmWorkspacePatterns, pnpmWorkspaceRoot } from '@/managers/workspaces'
import { readPnpmCatalogs } from '@/utils/catalogs'
import type { NpmrcSources } from '@/utils/npmrcLoader'
import { tempDir } from '../fixtures/files'

jest.mock('@/utils/logger')

let tmp: string
const at = (...parts: string[]) => path.join(tmp, ...parts)
const sources = (): NpmrcSources => ({
  env: { XDG_CONFIG_HOME: at('xdg') },
  home: at('home'),
  execPath: at('prefix', 'bin', 'node'),
  platform: process.platform,
})

beforeEach(() => {
  tmp = tempDir('autd-pnpm-yaml-', { real: true })
  fs.mkdirSync(at('packages', 'a'), { recursive: true })
  fs.writeFileSync(at('packages', 'a', 'package.json'), '{}')
})

/** What every consumer takes from one pnpm-workspace.yaml (#229). */
const consumers = (yaml: string) => {
  fs.writeFileSync(at('pnpm-workspace.yaml'), yaml)
  const workspace = pnpm.readWorkspace(tmp)
  const routes = pnpmNpmrcLayers(tmp, sources())[2].values
  const gate = pnpmReleaseAgeGate(tmp, sources())
  return {
    packages: pnpmWorkspacePatterns(yaml),
    member: pnpmWorkspaceRoot(at('packages', 'a')) === tmp,
    isWorkspace: workspace.isWorkspace,
    catalogs: workspace.catalogs,
    overrides: Object.fromEntries(
      Object.entries(pnpm.overrides(tmp)).map(([name, { range }]) => [
        name,
        range,
      ]),
    ),
    saveStyle: pnpm.saveStyle(tmp),
    nodeVersion: pnpm.nodeVersion?.(tmp),
    registry: routes.registry,
    scopes: pnpmRegistrySettings(yaml).scopes,
    fetchTimeout: routes['fetch-timeout'],
    minutes: gate.minutes,
    exempt: gate.exempt.map((exemption) => exemption.name),
  }
}

/** A file that sets every key a consumer reads, in the plain block form. */
const BLOCK = [
  'packages:',
  '  - packages/*',
  'catalog:',
  '  ms: ^2.1.1',
  'catalogs:',
  '  tools:',
  '    debug: ~4.3.1',
  'overrides:',
  '  dayjs: 1.11.9',
  'savePrefix: "~"',
  'saveExact: true',
  'nodeVersion: 20.0.0',
  'registry: http://r.test/',
  'registries:',
  '  "@acme": http://a.test/',
  'fetchTimeout: 900',
  'minimumReleaseAge: 30',
  'minimumReleaseAgeExclude:',
  '  - p-*',
  '',
]

const EXPECTED = {
  packages: ['packages/*'],
  member: true,
  isWorkspace: true,
  catalogs: { default: { ms: '^2.1.1' }, tools: { debug: '~4.3.1' } },
  overrides: { dayjs: '1.11.9' },
  saveStyle: { exact: true, prefix: '~' },
  nodeVersion: '20.0.0',
  registry: 'http://r.test/',
  scopes: { '@acme': 'http://a.test/' },
  fetchTimeout: '900',
  minutes: 30,
  exempt: ['p-*'],
}

describe('one pnpm-workspace.yaml read the same way by every consumer (#229)', () => {
  it('reads the block form', () => {
    expect(consumers(BLOCK.join('\n'))).toEqual(EXPECTED)
  })

  it.each([
    ['CRLF line ends', BLOCK.join('\r\n')],
    ['a byte order mark', `﻿${BLOCK.join('\n')}`],
    [
      'full-line and inline comments',
      BLOCK.flatMap((line) =>
        line === '' ? [] : ['  # between', `${line} # after`],
      ).join('\n'),
    ],
    [
      'single and double quotes',
      BLOCK.map((line) =>
        line
          .replace(/^( *)([\w@"-][^:]*?): (\S.*)$/, (_, indent, key, value) =>
            /^["']/.test(value)
              ? `${indent}'${key.replace(/"/g, '')}': ${value}`
              : `${indent}"${key.replace(/"/g, '')}": '${value}'`,
          )
          .replace(/^( *)- (.*)$/, "$1- '$2'"),
      ).join('\n'),
    ],
    [
      'flow sequences and flat flow maps',
      [
        "packages: ['packages/*']",
        'catalog: { ms: ^2.1.1 }',
        'catalogs:',
        '  tools: { debug: ~4.3.1 }',
        'overrides: { dayjs: 1.11.9 }',
        'savePrefix: "~"',
        'saveExact: true',
        'nodeVersion: 20.0.0',
        'registry: http://r.test/',
        'registries: { "@acme": http://a.test/ }',
        'fetchTimeout: 900',
        'minimumReleaseAge: 30',
        'minimumReleaseAgeExclude: [p-*]',
      ].join('\n'),
    ],
    [
      'tabs in blank and comment lines',
      BLOCK.join('\n').replace('catalogs:', '\t\ncatalogs:\n\t# tools'),
    ],
    [
      'anchors on values',
      BLOCK.join('\n')
        .replace('catalog:', 'catalog: &c')
        .replace('savePrefix: "~"', 'savePrefix: &p "~"'),
    ],
    [
      'a sequence at its key’s indent and deeper catalog entries',
      BLOCK.join('\n')
        .replace('  - packages/*', '- packages/*')
        .replace('    debug: ~4.3.1', '        debug: ~4.3.1'),
    ],
  ])('reads the same with %s', (_, yaml) => {
    expect(consumers(yaml)).toEqual(EXPECTED)
  })

  it('reads URL-keyed registries entries, block and flow', () => {
    const yaml = [
      'registries:',
      '  http://a.test:4873/:',
      '    scopes:',
      '      - "@acme"',
      '  http://b.test/: { ecosystem: npm, scopes: ["@b"] }',
      '  http://c.test/: { ecosystem: pypi, scopes: ["@c"] }',
    ].join('\n')
    expect(consumers(yaml).scopes).toEqual({
      '@acme': 'http://a.test:4873/',
      '@b': 'http://b.test/',
    })
  })

  it('leaves out a nested flow map, an alias and a block scalar, and every consumer agrees', () => {
    const yaml = [
      'registries: { http://a.test/: { scopes: ["@acme"] } }',
      'catalog: *c',
      'registry: |',
      '  http://r.test/',
      'savePrefix: >-',
      '  ~',
      'overrides:',
      '  dayjs: 1.11.9',
    ].join('\n')
    const read = consumers(yaml)
    expect(read).toMatchObject({
      catalogs: {},
      registry: undefined,
      scopes: {},
      saveStyle: { exact: false, prefix: '^' },
      overrides: { dayjs: '1.11.9' },
    })
  })

  it('takes an empty value as unset, for every consumer', () => {
    const read = consumers(
      'packages:\ncatalog:\noverrides:\nsavePrefix:\nregistry:\nnodeVersion:\nfetchTimeout:\nminimumReleaseAgeExclude:\n',
    )
    expect(read).toEqual({
      packages: [],
      member: false,
      isWorkspace: false,
      catalogs: {},
      overrides: {},
      saveStyle: { exact: false, prefix: '^' },
      nodeVersion: undefined,
      registry: undefined,
      scopes: {},
      fetchTimeout: undefined,
      minutes: 1440,
      exempt: [],
    })
  })

  it('takes the last of duplicate keys, for every consumer', () => {
    const yaml = [
      ...BLOCK,
      'packages:',
      '  - apps/*',
      'catalog:',
      '  ms: ^2.1.3',
      'overrides:',
      '  ms: 2.1.1',
      'savePrefix: "^"',
      'registry: http://s.test/',
      '',
    ].join('\n')
    expect(consumers(yaml)).toMatchObject({
      packages: ['apps/*'],
      member: false,
      catalogs: { default: { ms: '^2.1.3' } },
      overrides: { ms: '2.1.1' },
      saveStyle: { prefix: '^' },
      registry: 'http://s.test/',
    })
  })

  it('reads nothing from a file with a tab before content, which pnpm fails on', () => {
    const yaml = BLOCK.join('\n').replace('  ms: ^2.1.1', '\tms: ^2.1.1')
    expect(consumers(yaml)).toMatchObject({
      packages: [],
      isWorkspace: false,
      catalogs: {},
      overrides: {},
      saveStyle: { exact: false, prefix: '^' },
      registry: undefined,
      minutes: 1440,
    })
  })

  it('reads YAML scalars as YAML: escapes, a # with no space before it, and ~ as null', () => {
    const read = consumers(
      [
        'savePrefix: ~',
        'registry: "http://r.test/\\u0061"',
        'overrides:',
        '  ms: 2.1.1#x',
        'catalog:',
        "  ms: 'it''s'",
      ].join('\n'),
    )
    expect(read).toMatchObject({
      saveStyle: { prefix: '^' },
      registry: 'http://r.test/a',
      overrides: { ms: '2.1.1#x' },
      catalogs: { default: { ms: "it's" } },
    })
  })

  it('keeps only string values, and patterns that are strings', () => {
    const yaml = [
      'packages:',
      '  - name: x',
      '  - packages/*',
      'catalog:',
      '  react:',
      '    nested: ^1',
      '  ms: ^2',
      'overrides:',
      '  a:',
      '    b: 1.0.0',
    ].join('\n')
    expect(consumers(yaml)).toMatchObject({
      packages: ['packages/*'],
      catalogs: { default: { ms: '^2' } },
      overrides: {},
    })
  })
})

describe('the shared reader', () => {
  it('is empty for a missing file', () => {
    expect(readPnpmWorkspaceYaml(at('nowhere'))).toEqual({})
  })

  it('gives each accessor its part of one parse', () => {
    const doc = parsePnpmYaml(BLOCK.join('\n'))
    expect(pnpmPackages(doc)).toEqual(['packages/*'])
    expect(pnpmCatalogs(doc)).toEqual(EXPECTED.catalogs)
    expect(pnpmOverrides(doc)).toEqual(EXPECTED.overrides)
    expect(pnpmSetting(doc, 'savePrefix')).toBe('~')
    expect(pnpmSetting(doc, 'catalog')).toBeUndefined()
    expect(pnpmRegistrySettings(doc)).toEqual(
      pnpmRegistrySettings(BLOCK.join('\n')),
    )
  })

  it('merges `catalogs: default:` into the default catalog', () => {
    expect(
      readPnpmCatalogs(
        'catalog:\n  ms: ^2\ncatalogs:\n  default:\n    debug: ^4\n  empty:\n',
      ),
    ).toEqual({ default: { ms: '^2', debug: '^4' } })
  })
})
