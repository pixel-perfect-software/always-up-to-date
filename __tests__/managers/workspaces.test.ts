import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  readWorkspaceManifests,
  workspaceOwner,
  workspacePatterns,
} from '@/managers/workspaces'
import { StepError } from '@/stepError'

jest.mock('@/utils/logger')

describe('workspacePatterns', () => {
  it('reads the array form and the { packages } form', () => {
    expect(workspacePatterns({ workspaces: ['a', 'b/*'] })).toEqual([
      'a',
      'b/*',
    ])
    expect(workspacePatterns({ workspaces: { packages: ['c'] } })).toEqual([
      'c',
    ])
  })

  it('is empty without usable patterns', () => {
    expect(workspacePatterns(undefined)).toEqual([])
    expect(workspacePatterns({})).toEqual([])
    expect(workspacePatterns({ workspaces: { nohoist: ['x'] } })).toEqual([])
    expect(workspacePatterns({ workspaces: [1, 'a'] })).toEqual(['a'])
  })
})

describe('readWorkspaceManifests', () => {
  let cwd: string

  const pkg = (dir: string, manifest: object = { name: dir }): void => {
    fs.mkdirSync(path.join(cwd, dir), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, dir, 'package.json'),
      JSON.stringify(manifest),
    )
  }
  const paths = (patterns: string[]): string[] =>
    readWorkspaceManifests(cwd, patterns).map((m) => m.path)

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-workspaces-'))
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ name: 'root' }),
    )
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('puts the root first, with its name', () => {
    pkg('packages/a')

    expect(readWorkspaceManifests(cwd, ['packages/*'])).toEqual([
      { path: '.', name: 'root' },
      { path: 'packages/a', name: 'packages/a' },
    ])
  })

  it('matches a literal directory', () => {
    pkg('tools/cli')
    pkg('tools/other')

    expect(paths(['tools/cli'])).toEqual(['.', 'tools/cli'])
  })

  it('matches dir/* one level down, sorted, skipping directories without a package.json', () => {
    pkg('packages/b')
    pkg('packages/a')
    fs.mkdirSync(path.join(cwd, 'packages/docs'))
    pkg('packages/a/nested')

    expect(paths(['packages/*'])).toEqual(['.', 'packages/a', 'packages/b'])
  })

  it('matches ? within a segment', () => {
    pkg('pkg-1')
    pkg('pkg-22')

    expect(paths(['pkg-?'])).toEqual(['.', 'pkg-1'])
  })

  it('matches ** at any depth, skipping node_modules and dot-directories', () => {
    pkg('packages/a')
    pkg('packages/deep/b')
    pkg('packages/node_modules/dep')
    pkg('packages/.cache/c')

    expect(paths(['packages/**'])).toEqual([
      '.',
      'packages/a',
      'packages/deep/b',
    ])
  })

  it('walks into a dot-directory only when the pattern names it', () => {
    pkg('.tools/x')

    expect(paths(['*/x'])).toEqual(['.'])
    expect(paths(['.tools/*'])).toEqual(['.', '.tools/x'])
  })

  it('applies negations after the positive patterns', () => {
    pkg('packages/a')
    pkg('packages/b')
    pkg('packages/legacy/old')

    expect(
      paths([
        '!packages/b',
        'packages/*',
        '!packages/legacy/**',
        'packages/**',
      ]),
    ).toEqual(['.', 'packages/a'])
  })

  it('skips symlinked directories', () => {
    pkg('real')
    fs.symlinkSync(path.join(cwd, 'real'), path.join(cwd, 'link'))

    expect(paths(['*'])).toEqual(['.', 'real'])
  })

  it('keeps a member without a name', () => {
    pkg('packages/anon', { version: '1.0.0' })

    expect(readWorkspaceManifests(cwd, ['packages/*'])).toContainEqual({
      path: 'packages/anon',
    })
  })

  it('expands braces, including in a negation', () => {
    pkg('packages/core')
    pkg('packages/cli')
    pkg('packages/docs')
    pkg('tools/lint')

    expect(paths(['{packages,tools}/*', '!packages/{docs,cli}'])).toEqual([
      '.',
      'packages/core',
      'tools/lint',
    ])
  })

  it('reads character classes and negated classes', () => {
    pkg('packages/a1')
    pkg('packages/b1')
    pkg('packages/c1')

    expect(paths(['packages/[ab]1'])).toEqual([
      '.',
      'packages/a1',
      'packages/b1',
    ])
    expect(paths(['packages/[!a]1'])).toEqual([
      '.',
      'packages/b1',
      'packages/c1',
    ])
  })

  it('matches nothing for an extglob', () => {
    pkg('packages/a')

    expect(paths(['@(packages)/a', '+(packages)/*'])).toEqual(['.'])
  })

  it('lists only the root outside a workspace and for a root without a name', () => {
    fs.writeFileSync(path.join(cwd, 'package.json'), '{}')

    expect(readWorkspaceManifests(cwd, [])).toEqual([{ path: '.' }])
  })
})

describe('workspaceOwner', () => {
  const manifests = [
    { path: '.', name: 'ws-root' },
    { path: 'packages/a', name: '@ws/a' },
  ]

  it('resolves a workspace name to its directory', () => {
    const ownerOf = workspaceOwner(manifests, 'yarn')

    expect(ownerOf('ws-root')).toBe('.')
    expect(ownerOf('@ws/a')).toBe('packages/a')
  })

  it('throws a discover StepError for a name no manifest declares', () => {
    const ownerOf = workspaceOwner(manifests, 'yarn')

    expect(() => ownerOf('@ws/zzz')).toThrow(StepError)
    expect(() => ownerOf('@ws/zzz')).toThrow(
      'yarn reported workspace "@ws/zzz", which no manifest matched by the workspaces patterns declares',
    )
    try {
      ownerOf('@ws/zzz')
    } catch (error) {
      expect((error as StepError).step).toBe('discover')
    }
  })

  it('reads the empty name as the root only when the root has no name', () => {
    expect(workspaceOwner([{ path: '.' }], 'bun')('')).toBe('.')
    expect(() => workspaceOwner(manifests, 'bun')('')).toThrow(StepError)
  })
})
