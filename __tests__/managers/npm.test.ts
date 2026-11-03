import fs from 'fs'
import os from 'os'
import path from 'path'
import npm, { readLockedPackages } from '@/managers/npm'
import { check } from '@/pipeline'
import { capturedRegistry, projectFor } from '../fixtures'

jest.mock('@/utils/logger')

// Real captures: npm 11.19.1 `install --package-lock-only` on
// testRepos/npm-workspace (2026-11-03), and a single package's lockfile.
const fixture = (name: string) => path.join(__dirname, '../fixtures/npm', name)

describe('readLockedPackages', () => {
  let cwd: string
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-npm-lock-'))
  })
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })
  const lock = (name: string) =>
    fs.copyFileSync(fixture(name), path.join(cwd, 'package-lock.json'))

  it("reads a member's nested copy first, then the root's hoisted one", () => {
    lock('workspace-no-node-modules.package-lock.json')

    expect(
      readLockedPackages(cwd, [
        { name: 'ms', workspace: '.' },
        { name: 'dayjs', workspace: '.' },
        { name: 'ms', workspace: 'packages/a' },
        { name: 'chalk', workspace: 'packages/a' },
        { name: 'debug', workspace: 'packages/b' },
        { name: 'kleur', workspace: 'packages/b' },
      ]),
    ).toEqual({
      '.:ms': { version: '2.1.3', linked: false },
      '.:dayjs': { version: '1.11.9', linked: false },
      'packages/a:ms': { version: '2.1.2', linked: false },
      'packages/a:chalk': { version: '4.1.2', linked: false },
      'packages/b:debug': { version: '4.3.7', linked: false },
      'packages/b:kleur': { version: '3.0.3', linked: false },
    })
  })

  it('marks a workspace member as linked, with its own version', () => {
    lock('workspace-no-node-modules.package-lock.json')

    expect(
      readLockedPackages(cwd, [{ name: '@autd/a', workspace: 'packages/b' }]),
    ).toEqual({ 'packages/b:@autd/a': { version: '1.0.0', linked: true } })
  })

  it('keys a single package by name and leaves out what the lockfile lacks', () => {
    lock('no-node-modules.package-lock.json')

    expect(
      readLockedPackages(cwd, [{ name: 'chalk' }, { name: 'not-locked' }]),
    ).toEqual({ chalk: { version: '4.0.0', linked: false } })
  })

  it('is empty without a readable lockfile', () => {
    expect(readLockedPackages(cwd, [{ name: 'chalk' }])).toEqual({})
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{ not json')
    expect(readLockedPackages(cwd, [{ name: 'chalk' }])).toEqual({})
  })
})

describe('npm installedFromLockfile', () => {
  let cwd: string
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-npm-locked-'))
  })
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('reads package-lock.json only when there is no node_modules', () => {
    expect(npm.installedFromLockfile?.(cwd)).toBeUndefined()
    fs.copyFileSync(
      fixture('no-node-modules.package-lock.json'),
      path.join(cwd, 'package-lock.json'),
    )
    expect(npm.installedFromLockfile?.(cwd)).toEqual({
      file: 'package-lock.json',
      read: readLockedPackages,
    })
    fs.mkdirSync(path.join(cwd, 'node_modules'))
    expect(npm.installedFromLockfile?.(cwd)).toBeUndefined()
  })
})

// #107: an npm workspace with a lockfile and no node_modules lists its
// members' rows; before, discovery failed with "run `npm install`". The
// manifests are testRepos/npm-workspace's, keeping the packages the registry
// captures hold (dayjs, ms, debug), with the capture's real lockfile.
describe('npm check without node_modules', () => {
  const AS_OF = '2026-10-23T16:38:12-03:00'
  let cwd: string
  const write = (file: string, manifest: object) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
    fs.writeFileSync(path.join(cwd, file), JSON.stringify(manifest))
  }
  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-npm-nomodules-'))
    write('package.json', {
      name: 'autd-npm-workspace',
      workspaces: ['packages/*'],
      dependencies: { dayjs: '1.11.9', ms: '~2.1.1' },
    })
    write('packages/a/package.json', {
      name: '@autd/a',
      dependencies: { ms: '2.1.2' },
    })
    write('packages/b/package.json', {
      name: '@autd/b',
      dependencies: { '@autd/a': '*', debug: '~4.3.1' },
    })
    fs.copyFileSync(
      fixture('workspace-no-node-modules.package-lock.json'),
      path.join(cwd, 'package-lock.json'),
    )
  })
  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it("lists the members' rows with the lockfile's versions", async () => {
    const outdated = await check(
      projectFor(
        npm,
        cwd,
        {},
        capturedRegistry(['dayjs', 'ms', 'debug'], { asOf: AS_OF }),
      ),
    )

    // `@autd/a` is a member (a link entry), so it is not looked up.
    expect(outdated).toEqual({
      dayjs: expect.objectContaining({
        current: '1.11.9',
        latest: '1.11.23',
        workspaces: [{ path: '.', current: '1.11.9', wanted: '1.11.9' }],
      }),
      debug: expect.objectContaining({
        current: '4.3.7',
        workspaces: [{ path: 'packages/b', current: '4.3.7', wanted: '4.3.7' }],
      }),
      ms: expect.objectContaining({
        current: '2.1.2',
        latest: '2.1.3',
        workspaces: [{ path: 'packages/a', current: '2.1.2', wanted: '2.1.2' }],
      }),
    })
  })
})
