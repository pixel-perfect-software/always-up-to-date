import fs from 'fs'
import os from 'os'
import path from 'path'
import { StepError } from '@/stepError'
import {
  type Catalogs,
  classifySpec,
  DEPENDENCY_FIELDS,
  DISCOVERED_FIELDS,
  readDeclaredDependencies,
} from '@/utils/dependencySpecs'
import logger from '@/utils/logger'

jest.mock('@/utils/logger')

const catalogs: Catalogs = {
  default: { react: '^18.0.0' },
  tools: { eslint: '~9.1.0', typescript: 'latest' },
}

describe('classifySpec', () => {
  const registry = (name: string, spec: object) => ({
    kind: 'registry',
    name,
    spec,
  })

  it.each([
    ['a range', 'ms', '~2.1.1', registry('ms', { range: '~2.1.1' })],
    ['an exact pin', 'ms', '2.1.3', registry('ms', { range: '2.1.3' })],
    [
      'a compound range',
      'ms',
      '>=1 <2 || ^3',
      registry('ms', { range: '>=1 <2 || ^3' }),
    ],
    ['an empty spec as *', 'ms', '', registry('ms', { range: '*' })],
    ['latest', 'ms', 'latest', registry('ms', { tag: 'latest' })],
    [
      'an alias',
      'dj',
      'npm:dayjs@^1.11.0',
      registry('dayjs', { range: '^1.11.0' }),
    ],
    [
      'an alias with a scoped target',
      'types',
      'npm:@types/node@^20.0.0',
      registry('@types/node', { range: '^20.0.0' }),
    ],
    [
      'an alias to latest',
      'dj',
      'npm:dayjs@latest',
      registry('dayjs', { tag: 'latest' }),
    ],
    ['catalog:', 'react', 'catalog:', registry('react', { range: '^18.0.0' })],
    [
      'catalog:default',
      'react',
      'catalog:default',
      registry('react', { range: '^18.0.0' }),
    ],
    [
      'catalog:tools',
      'eslint',
      'catalog:tools',
      registry('eslint', { range: '~9.1.0' }),
    ],
    [
      'a catalog entry that is latest',
      'typescript',
      'catalog:tools',
      registry('typescript', { tag: 'latest' }),
    ],
  ])('%s is a registry dependency', (_label, key, spec, expected) => {
    expect(classifySpec(key, spec, catalogs)).toEqual(expected)
  })

  it.each([
    ['workspace:^', 'workspace:^'],
    ['workspace:*', 'workspace:*'],
    ['a git url', 'git+https://github.com/a/b.git#v1'],
    ['github shorthand', 'github:a/b'],
    ['owner/repo', 'a/b'],
    ['file:', 'file:../lib'],
    ['link:', 'link:../lib'],
    ['an https url', 'https://example.com/ms.tgz'],
  ])('%s is skipped without a warning', (_label, spec) => {
    expect(classifySpec('ms', spec, catalogs)).toMatchObject({
      kind: 'skipped',
      warn: false,
    })
  })

  it.each([
    ['an unknown catalog', 'catalog:nope'],
    ['an entry the catalog lacks', 'catalog:tools'],
    ['another dist-tag', 'next'],
  ])('%s is skipped with a warning', (_label, spec) => {
    expect(classifySpec('ms', spec, catalogs)).toMatchObject({
      kind: 'skipped',
      warn: true,
    })
  })

  it('skips a catalog entry that is not a registry spec', () => {
    expect(
      classifySpec('x', 'catalog:', { default: { x: 'workspace:*' } }),
    ).toMatchObject({ kind: 'skipped', warn: false })
  })
})

describe('field lists', () => {
  it('discovers every field but peerDependencies', () => {
    expect(DISCOVERED_FIELDS).toEqual([
      'dependencies',
      'devDependencies',
      'optionalDependencies',
    ])
    expect(DEPENDENCY_FIELDS).toEqual([
      ...DISCOVERED_FIELDS,
      'peerDependencies',
    ])
  })
})

describe('readDeclaredDependencies', () => {
  let cwd: string

  const write = (file: string, content: object | string) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, file),
      typeof content === 'string' ? content : JSON.stringify(content),
    )
  }
  const root = [{ path: '.' }]

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-declared-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('reads the fields in order and the first field wins a duplicate key', () => {
    write('package.json', {
      optionalDependencies: { fsevents: '^2.0.0', ms: '1.0.0' },
      devDependencies: { jest: '^29.0.0', ms: '2.0.0' },
      dependencies: { ms: '~2.1.1', semver: '^7.0.0' },
    })

    expect(
      readDeclaredDependencies(cwd, { manifests: root, catalogs: {} }).map(
        ({ key, field, spec }) => [key, field, spec],
      ),
    ).toEqual([
      ['ms', 'dependencies', { range: '~2.1.1' }],
      ['semver', 'dependencies', { range: '^7.0.0' }],
      ['jest', 'devDependencies', { range: '^29.0.0' }],
      ['fsevents', 'optionalDependencies', { range: '^2.0.0' }],
    ])
  })

  it('does not discover a peer-only key', () => {
    write('package.json', {
      dependencies: { ms: '2.1.3' },
      peerDependencies: { react: '^18.0.0', ms: '^2.0.0' },
    })

    expect(
      readDeclaredDependencies(cwd, { manifests: root, catalogs: {} }).map(
        ({ key }) => key,
      ),
    ).toEqual(['ms'])
  })

  it('resolves pnpm and bun catalog references, and keeps the alias target apart from the key', () => {
    write('package.json', {
      dependencies: {
        react: 'catalog:',
        eslint: 'catalog:tools',
        dj: 'npm:dayjs@1.11.9',
      },
    })

    expect(
      readDeclaredDependencies(cwd, { manifests: root, catalogs }).map(
        ({ key, name, spec }) => [key, name, spec],
      ),
    ).toEqual([
      ['react', 'react', { range: '^18.0.0' }],
      ['eslint', 'eslint', { range: '~9.1.0' }],
      ['dj', 'dayjs', { range: '1.11.9' }],
    ])
  })

  it('reads the members in the order given, with their path', () => {
    write('package.json', { dependencies: { ms: '~2.1.1' } })
    write('packages/a/package.json', {
      name: '@ws/a',
      dependencies: { ms: '2.1.2' },
    })
    write('packages/b/package.json', {
      name: '@ws/b',
      devDependencies: { debug: '~4.3.1' },
    })

    expect(
      readDeclaredDependencies(cwd, {
        manifests: [
          { path: '.' },
          { path: 'packages/a', name: '@ws/a' },
          { path: 'packages/b', name: '@ws/b' },
        ],
        catalogs: {},
      }).map(({ workspace, key }) => [workspace, key]),
    ).toEqual([
      ['.', 'ms'],
      ['packages/a', 'ms'],
      ['packages/b', 'debug'],
    ])
  })

  it('leaves out specs that never reach the registry, with a debug line, and warns about a dist-tag', () => {
    write('package.json', {
      dependencies: {
        a: 'workspace:*',
        b: 'git+https://example.com/b.git',
        c: 'next',
        ms: '2.1.3',
      },
    })

    expect(
      readDeclaredDependencies(cwd, { manifests: root, catalogs: {} }).map(
        ({ key }) => key,
      ),
    ).toEqual(['ms'])
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('skipping a'),
    )
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('skipping b'),
    )
    expect(logger.warn).toHaveBeenCalledTimes(1)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('skipping c'),
    )
  })

  it('throws a discover StepError for a member manifest that is not valid JSON', () => {
    write('package.json', { dependencies: { ms: '2.1.3' } })
    write('packages/a/package.json', '{ not json')

    let failure: unknown
    try {
      readDeclaredDependencies(cwd, {
        manifests: [{ path: '.' }, { path: 'packages/a' }],
        catalogs: {},
      })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeInstanceOf(StepError)
    expect(failure).toMatchObject({ step: 'discover' })
    expect((failure as Error).message).toContain(
      "packages/a/package.json can't be read",
    )
  })

  it('throws a discover StepError for a missing root manifest', () => {
    expect(() =>
      readDeclaredDependencies(cwd, { manifests: root, catalogs: {} }),
    ).toThrow(/^package\.json can't be read: /)
  })

  it('throws a discover StepError for a manifest that is not an object', () => {
    write('package.json', '[]')
    expect(() =>
      readDeclaredDependencies(cwd, { manifests: root, catalogs: {} }),
    ).toThrow(StepError)
  })
})

describe('classifySpec with a bare npm: alias', () => {
  // npm 11.19.1: `"l": "npm:ms"` installs ms@latest as node_modules/l.
  it('is the latest tag of the aliased name', () => {
    expect(classifySpec('l', 'npm:ms', {})).toEqual({
      kind: 'registry',
      name: 'ms',
      spec: { tag: 'latest' },
    })
    expect(classifySpec('l', 'npm:@scope/pkg', {})).toEqual({
      kind: 'registry',
      name: '@scope/pkg',
      spec: { tag: 'latest' },
    })
  })
})
