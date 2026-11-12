import fs from 'fs'
import path from 'path'
import npm, { readLockedPackages, readLockedPeers } from '@/managers/npm'
import { check } from '@/pipeline'
import { capturedRegistry, projectFor } from '../fixtures'
import { tempDir, write as writeFile } from '../fixtures/files'

jest.mock('@/utils/logger')

// Real captures: npm 11.19.1 `install --package-lock-only` on
// testRepos/npm-workspace (2026-11-03), and a single package's lockfile.
const fixture = (name: string) => path.join(__dirname, '../fixtures/npm', name)

describe('readLockedPackages', () => {
  let cwd: string
  beforeEach(() => {
    cwd = tempDir('autd-npm-lock-')
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

// #232: the shape `readInstalledPeers` reads from node_modules.
describe('readLockedPeers', () => {
  let cwd: string
  beforeEach(() => {
    cwd = tempDir('autd-npm-peers-')
  })
  const captured = () =>
    JSON.parse(
      fs.readFileSync(
        fixture('peers-no-node-modules.package-lock.json'),
        'utf8',
      ),
    )
  const lockWith = (lockfile: object) =>
    writeFile(path.join(cwd, 'package-lock.json'), lockfile)

  it("reads each hoisted entry's peer ranges, scoped and optional ones included", () => {
    lockWith(captured())
    const peers = readLockedPeers(cwd)

    expect(peers.get('react')).toEqual([
      {
        name: 'react-redux',
        version: '8.1.3',
        range: '^16.8 || ^17.0 || ^18.0',
      },
      {
        name: 'use-sync-external-store',
        version: '1.7.0',
        range: '^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0',
      },
    ])
    expect(peers.get('@types/react')).toEqual([
      { name: '@types/hoist-non-react-statics', version: '3.3.7', range: '*' },
      {
        name: 'react-redux',
        version: '8.1.3',
        range: '^16.8 || ^17.0 || ^18.0',
      },
    ])
    expect(peers.get('redux')).toEqual([
      { name: 'react-redux', version: '8.1.3', range: '^4 || ^5.0.0-beta.0' },
    ])
    expect([...peers.keys()].sort()).toEqual([
      '@types/react',
      '@types/react-dom',
      'react',
      'react-dom',
      'react-native',
      'redux',
    ])
  })

  // The node_modules scan reads only the root's node_modules, so a nested
  // copy doesn't count. Derived: the capture's react-redux entry moved under
  // another package.
  it('leaves out a nested copy, as the node_modules scan does', () => {
    const lockfile = captured()
    const { packages } = lockfile
    packages['node_modules/hoist-non-react-statics/node_modules/react-redux'] =
      packages['node_modules/react-redux']
    delete packages['node_modules/react-redux']
    lockWith(lockfile)

    expect(readLockedPeers(cwd).get('react')).toEqual([
      {
        name: 'use-sync-external-store',
        version: '1.7.0',
        range: '^16.8.0 || ^17.0.0 || ^18.0.0 || ^19.0.0',
      },
    ])
  })

  // A member is linked into node_modules, so the scan reads its manifest.
  // Derived: the capture's react-redux entry made a member's.
  it("reads a linked member's peers from the entry it resolves to", () => {
    const lockfile = captured()
    const { packages } = lockfile
    packages['packages/rr'] = packages['node_modules/react-redux']
    packages['node_modules/react-redux'] = {
      resolved: 'packages/rr',
      link: true,
    }
    lockWith(lockfile)

    expect(readLockedPeers(cwd).get('react')?.[0]).toEqual({
      name: 'react-redux',
      version: '8.1.3',
      range: '^16.8 || ^17.0 || ^18.0',
    })
  })

  it('is empty without peer ranges or a readable lockfile', () => {
    expect(readLockedPeers(cwd)).toEqual(new Map())
    fs.copyFileSync(
      fixture('workspace-no-node-modules.package-lock.json'),
      path.join(cwd, 'package-lock.json'),
    )
    // debug 4.3.7 has peerDependenciesMeta and no peerDependencies.
    expect(readLockedPeers(cwd)).toEqual(new Map())
    fs.writeFileSync(path.join(cwd, 'package-lock.json'), '{ not json')
    expect(readLockedPeers(cwd)).toEqual(new Map())
  })
})

describe('npm installedFromLockfile', () => {
  let cwd: string
  beforeEach(() => {
    cwd = tempDir('autd-npm-locked-')
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
      peers: readLockedPeers,
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
    cwd = tempDir('autd-npm-nomodules-')
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
