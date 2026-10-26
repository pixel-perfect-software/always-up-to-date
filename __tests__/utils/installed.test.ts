import fs from 'fs'
import os from 'os'
import path from 'path'
import type { UpdateResult } from '@/types'
import {
  checkApplied,
  readInstalledPackages,
  readInstalledVersions,
} from '@/utils/installed'

describe('readInstalledVersions', () => {
  let cwd: string

  const writeJson = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(
      file,
      typeof value === 'string' ? value : JSON.stringify(value),
    )
  }
  const manifest = (value: unknown) =>
    writeJson(path.join(cwd, 'package.json'), value)
  const install = (dir: string, pkg: Record<string, unknown>) =>
    writeJson(path.join(cwd, dir, 'package.json'), pkg)

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-installed-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('reads the installed version of a dependency and a devDependency', () => {
    manifest({
      dependencies: { ms: '~2.1.1' },
      devDependencies: { jest: '^29.0.0' },
    })
    install('node_modules/ms', { name: 'ms', version: '2.1.1' })
    install('node_modules/jest', { name: 'jest', version: '29.7.0' })

    expect(
      readInstalledVersions(cwd, [{ name: 'ms' }, { name: 'jest' }]),
    ).toEqual({
      ms: '2.1.1',
      jest: '29.7.0',
    })
  })

  it('reads a scoped package', () => {
    manifest({ dependencies: { '@types/node': '^20.0.0' } })
    install('node_modules/@types/node', {
      name: '@types/node',
      version: '20.1.0',
    })

    expect(readInstalledVersions(cwd, [{ name: '@types/node' }])).toEqual({
      '@types/node': '20.1.0',
    })
  })

  it('reads an npm: alias from the folder named for the alias key', () => {
    manifest({ dependencies: { dj: 'npm:dayjs@1.11.9' } })
    install('node_modules/dj', { name: 'dayjs', version: '1.11.9' })

    expect(readInstalledVersions(cwd, [{ name: 'dj' }])).toEqual({
      dj: '1.11.9',
    })
  })

  it('follows a pnpm symlink into the store', () => {
    manifest({ dependencies: { ms: '~2.1.1' } })
    install('node_modules/.pnpm/ms@2.1.3/node_modules/ms', {
      name: 'ms',
      version: '2.1.3',
    })
    fs.symlinkSync(
      path.join(cwd, 'node_modules/.pnpm/ms@2.1.3/node_modules/ms'),
      path.join(cwd, 'node_modules/ms'),
      'junction',
    )

    expect(readInstalledVersions(cwd, [{ name: 'ms' }])).toEqual({
      ms: '2.1.3',
    })
  })

  it('skips a name only a workspace member declares', () => {
    manifest({ dependencies: { ms: '~2.1.1' }, workspaces: ['packages/*'] })
    install('node_modules/ms', { name: 'ms', version: '2.1.1' })
    install('node_modules/debug', { name: 'debug', version: '4.3.1' })

    expect(
      readInstalledVersions(cwd, [{ name: 'ms' }, { name: 'debug' }]),
    ).toEqual({ ms: '2.1.1' })
  })

  describe('in a workspace project', () => {
    const member = (dir: string, pkg: Record<string, unknown>) =>
      writeJson(path.join(cwd, dir, 'package.json'), pkg)

    beforeEach(() => {
      manifest({ dependencies: { ms: '~2.1.1' }, workspaces: ['packages/*'] })
      member('packages/a', { name: '@ws/a', dependencies: { ms: '2.1.2' } })
    })

    it("reads a member's nested copy ahead of the root's hoisted one", () => {
      install('node_modules/ms', { name: 'ms', version: '2.1.1' })
      install('packages/a/node_modules/ms', { name: 'ms', version: '2.1.2' })

      expect(
        readInstalledVersions(cwd, [
          { name: 'ms', workspace: '.' },
          { name: 'ms', workspace: 'packages/a' },
        ]),
      ).toEqual({ '.:ms': '2.1.1', 'packages/a:ms': '2.1.2' })
    })

    it("falls back to the root's hoisted copy when the member has none", () => {
      install('node_modules/ms', { name: 'ms', version: '2.1.2' })

      expect(
        readInstalledVersions(cwd, [{ name: 'ms', workspace: 'packages/a' }]),
      ).toEqual({ 'packages/a:ms': '2.1.2' })
    })

    it('skips a name the member does not declare', () => {
      install('node_modules/debug', { name: 'debug', version: '4.3.1' })

      expect(
        readInstalledVersions(cwd, [
          { name: 'debug', workspace: 'packages/a' },
        ]),
      ).toEqual({})
    })

    it("follows a pnpm member's symlink into the store", () => {
      install('node_modules/.pnpm/ms@2.1.2/node_modules/ms', {
        name: 'ms',
        version: '2.1.2',
      })
      fs.mkdirSync(path.join(cwd, 'packages/a/node_modules'), {
        recursive: true,
      })
      fs.symlinkSync(
        path.join(cwd, 'node_modules/.pnpm/ms@2.1.2/node_modules/ms'),
        path.join(cwd, 'packages/a/node_modules/ms'),
        'junction',
      )

      expect(
        readInstalledVersions(cwd, [{ name: 'ms', workspace: 'packages/a' }]),
      ).toEqual({ 'packages/a:ms': '2.1.2' })
    })
  })

  it('leaves out a declared name with no node_modules entry', () => {
    manifest({ dependencies: { ms: '~2.1.1' } })

    expect(readInstalledVersions(cwd, [{ name: 'ms' }])).toEqual({})
  })

  it('returns nothing when the root package.json cannot be parsed', () => {
    manifest('{ not json')
    install('node_modules/ms', { name: 'ms', version: '2.1.1' })

    expect(readInstalledVersions(cwd, [{ name: 'ms' }])).toEqual({})
  })
})

describe('checkApplied', () => {
  const row = (overrides: Partial<UpdateResult> = {}): UpdateResult => ({
    name: 'ms',
    current: '2.1.1',
    wanted: '2.1.3',
    latest: '2.1.3',
    target: '2.1.3',
    updateType: 'patch',
    updated: true,
    ...overrides,
  })

  it('turns a row whose installed version is below its target into not applied', () => {
    expect(checkApplied([row()], { ms: '2.1.1' }, 'npm')).toEqual([
      row({
        target: undefined,
        updated: false,
        reason: 'not applied by npm (installed 2.1.1)',
      }),
    ])
  })

  it('keeps a row installed at its target', () => {
    const rows = [row()]
    expect(checkApplied(rows, { ms: '2.1.3' }, 'npm')).toEqual(rows)
  })

  it('keeps a row installed above its target', () => {
    const rows = [row()]
    expect(checkApplied(rows, { ms: '2.2.0' }, 'npm')).toEqual(rows)
  })

  it('keeps a row with no installed version to check', () => {
    const rows = [row()]
    expect(checkApplied(rows, {}, 'npm')).toEqual(rows)
  })

  it('keeps a row whose installed version is not semver', () => {
    const rows = [row()]
    expect(checkApplied(rows, { ms: 'workspace:*' }, 'npm')).toEqual(rows)
  })

  it('leaves a row that was not updating untouched', () => {
    const held = row({
      updated: false,
      target: undefined,
      reason: 'held by config',
    })
    expect(checkApplied([held], { ms: '2.1.1' }, 'npm')).toEqual([held])
  })

  it('names the manager in the reason', () => {
    expect(checkApplied([row()], { ms: '2.1.1' }, 'pnpm')[0].reason).toBe(
      'not applied by pnpm (installed 2.1.1)',
    )
  })
})

describe('checkApplied in a workspace project', () => {
  const row = (workspace: string): UpdateResult => ({
    name: 'ms',
    workspace,
    current: '2.1.1',
    wanted: '2.1.3',
    latest: '2.1.3',
    target: '2.1.3',
    updateType: 'patch',
    updated: true,
  })

  it('judges each manifest against its own installed version', () => {
    const [root, member] = checkApplied(
      [row('.'), row('packages/a')],
      { '.:ms': '2.1.1', 'packages/a:ms': '2.1.3' },
      'npm',
    )

    expect(root).toMatchObject({
      workspace: '.',
      updated: false,
      reason: 'not applied by npm (installed 2.1.1)',
    })
    expect(member.updated).toBe(true)
  })
})

describe('readInstalledPackages', () => {
  let cwd: string

  const writeJson = (file: string, value: unknown) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(value))
  }

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-installed-packages-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('marks a member linked from the root node_modules', () => {
    writeJson(path.join(cwd, 'package.json'), {
      name: 'root',
      workspaces: ['packages/*'],
      dependencies: { '@ws/a': '*', ms: '2.1.3' },
    })
    writeJson(path.join(cwd, 'packages/a/package.json'), {
      name: '@ws/a',
      version: '1.0.0',
    })
    writeJson(path.join(cwd, 'node_modules/ms/package.json'), {
      name: 'ms',
      version: '2.1.3',
    })
    fs.mkdirSync(path.join(cwd, 'node_modules/@ws'), { recursive: true })
    fs.symlinkSync(
      path.join(cwd, 'packages/a'),
      path.join(cwd, 'node_modules/@ws/a'),
      'junction',
    )

    expect(
      readInstalledPackages(cwd, [{ name: '@ws/a' }, { name: 'ms' }]),
    ).toEqual({
      '@ws/a': { version: '1.0.0', linked: true },
      ms: { version: '2.1.3', linked: false },
    })
  })

  it('does not mark a pnpm-style store symlink', () => {
    writeJson(path.join(cwd, 'package.json'), {
      dependencies: { ms: '~2.1.1' },
    })
    writeJson(
      path.join(
        cwd,
        'node_modules/.pnpm/ms@2.1.3/node_modules/ms/package.json',
      ),
      { name: 'ms', version: '2.1.3' },
    )
    fs.symlinkSync(
      path.join(cwd, 'node_modules/.pnpm/ms@2.1.3/node_modules/ms'),
      path.join(cwd, 'node_modules/ms'),
      'junction',
    )

    expect(readInstalledPackages(cwd, [{ name: 'ms' }])).toEqual({
      ms: { version: '2.1.3', linked: false },
    })
  })

  it('does not mark a link that leaves the project', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-outside-'))
    try {
      writeJson(path.join(cwd, 'package.json'), {
        dependencies: { lib: 'file:../lib' },
      })
      writeJson(path.join(outside, 'package.json'), {
        name: 'lib',
        version: '3.0.0',
      })
      fs.mkdirSync(path.join(cwd, 'node_modules'))
      fs.symlinkSync(outside, path.join(cwd, 'node_modules/lib'), 'junction')

      expect(readInstalledPackages(cwd, [{ name: 'lib' }])).toEqual({
        lib: { version: '3.0.0', linked: false },
      })
    } finally {
      fs.rmSync(outside, { recursive: true, force: true })
    }
  })

  it('does not mark a plain directory', () => {
    writeJson(path.join(cwd, 'package.json'), {
      dependencies: { ms: '2.1.3' },
    })
    writeJson(path.join(cwd, 'node_modules/ms/package.json'), {
      name: 'ms',
      version: '2.1.3',
    })

    expect(readInstalledPackages(cwd, [{ name: 'ms' }]).ms.linked).toBe(false)
  })
})
