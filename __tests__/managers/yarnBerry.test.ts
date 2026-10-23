import fs from 'fs'
import os from 'os'
import path from 'path'
import yarn from '@/managers/yarn'
import { parseBerryInfo, parseBerryRegistry } from '@/managers/yarn/berry'
import { check, update } from '@/pipeline'
import { foldWorkspaceEntries } from '@/utils/workspaceRows'
import {
  exitError,
  projectFor,
  readFixture,
  WORKSPACE_ENTRIES,
  writeWorkspaceProject,
} from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils/registry', () => ({
  clearRegistryCache: jest.fn(),
  fetchReleaseTimes: jest.fn(),
}))
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { runProcess } from '@/utils'

const mockedRunProcess = jest.mocked(runProcess)

const INFO = ['info', '-A', '--json']

/**
 * Answers yarn's commands from captured output: `info` with each of `infos`
 * in turn (the last one for every later call), `npm info` with `registry`,
 * and any other command (`install`, `up`) with an empty success.
 */
const mockYarn = (infos: string[], registry: string) => {
  let infoCalls = 0
  mockedRunProcess.mockImplementation(async (_command, args) => {
    if (args[0] === 'info') {
      return {
        stdout: infos[Math.min(infoCalls++, infos.length - 1)],
        stderr: '',
      }
    }
    if (args[0] === 'npm') return { stdout: registry, stderr: '' }
    return { stdout: '', stderr: '' }
  })
}

/** The evidence workspace, with the root declaring yarn 4. */
const writeBerryWorkspace = (cwd: string): void => {
  writeWorkspaceProject(cwd)
  const file = path.join(cwd, 'package.json')
  fs.writeFileSync(
    file,
    JSON.stringify({
      ...JSON.parse(fs.readFileSync(file, 'utf8')),
      packageManager: 'yarn@4.12.0',
    }),
  )
}

const commands = (): string[][] =>
  mockedRunProcess.mock.calls.map(([, args]) => args)

describe('parseBerryInfo', () => {
  it('reads the root workspace of a single project, virtual hashes stripped', () => {
    const [root, ...rest] = parseBerryInfo(
      readFixture('yarn/berry-info.stdout'),
    )

    expect(rest).toEqual([])
    expect(root).toEqual({
      path: '.',
      dependencies: [
        { key: 'chalk', name: 'chalk', range: '^4.0.0', current: '4.0.0' },
        { key: 'dayjs', name: 'dayjs', range: '1.11.9', current: '1.11.9' },
        { key: 'debug', name: 'debug', range: '~4.3.1', current: '4.3.1' },
        { key: 'ms', name: 'ms', range: '~2.1.1', current: '2.1.1' },
      ],
    })
  })

  it('reads each workspace of a workspace project with its path', () => {
    const workspaces = parseBerryInfo(
      readFixture('yarn/berry-workspace-info.stdout'),
    )

    expect(workspaces.map(({ path: dir }) => dir).sort()).toEqual([
      '.',
      'packages/a',
      'packages/b',
    ])
    expect(
      workspaces.find(({ path: dir }) => dir === 'packages/b')?.dependencies,
    ).toEqual([
      { key: 'dayjs', name: 'dayjs', range: '^1.11.9', current: '1.11.9' },
      { key: 'debug', name: 'debug', range: '~4.3.1', current: '4.3.1' },
    ])
  })

  it('reads a builtin-patched package, an alias and a scoped name, and skips a link', () => {
    const [root] = parseBerryInfo(readFixture('yarn/berry-special-info.stdout'))

    expect(root.dependencies).toEqual([
      {
        key: '@sindresorhus/is',
        name: '@sindresorhus/is',
        range: '^4.0.0',
        current: '4.0.0',
      },
      { key: 'dj', name: 'dayjs', range: '^1.11.9', current: '1.11.9' },
      {
        key: 'typescript',
        name: 'typescript',
        range: '^5.4.0',
        current: '5.4.5',
      },
    ])
  })

  it('reads a project with no dependencies', () => {
    expect(parseBerryInfo(readFixture('yarn/berry-info-empty.stdout'))).toEqual(
      [{ path: '.', dependencies: [] }],
    )
  })

  it('fails discovery on a line it cannot read', () => {
    expect(() => parseBerryInfo('not json')).toThrow(
      expect.objectContaining({ step: 'discover' }),
    )
  })

  it("reads a locator's version past yarn's ::key=value parameters", () => {
    // Yarn appends `::__archiveUrl=…` to a locator whose tarball URL isn't
    // the registry's standard one (GitHub Packages, Artifactory).
    const archived = readFixture('yarn/berry-info.stdout').replace(
      '"locator":"chalk@npm:4.0.0"',
      '"locator":"chalk@npm:4.0.0::__archiveUrl=https%3A%2F%2Fnpm.pkg.github.com%2Fdownload%2Fchalk%2F4.0.0%2Fchalk-4.0.0.tgz"',
    )

    const [root] = parseBerryInfo(archived)

    expect(root.dependencies.find((d) => d.name === 'chalk')).toMatchObject({
      current: '4.0.0',
    })
  })
})

describe('parseBerryRegistry', () => {
  it('reads the latest tag and the versions of each package', () => {
    const registry = parseBerryRegistry(
      readFixture('yarn/berry-npm-info.stdout'),
    )

    expect([...registry.keys()]).toEqual(['chalk', 'dayjs', 'debug', 'ms'])
    expect(registry.get('ms')?.latest).toBe('2.1.3')
    expect(registry.get('ms')?.versions).toContain('2.1.1')
  })
})

describe('check with yarn berry', () => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-berry-check-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  const writeManifest = (manifest: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ packageManager: 'yarn@4.12.0', ...manifest }),
    )

  it('has no outdated command: it reads yarn info, then asks the registry through yarn', async () => {
    writeManifest({
      dependencies: {
        chalk: '^4.0.0',
        dayjs: '1.11.9',
        debug: '~4.3.1',
        ms: '~2.1.1',
      },
    })
    mockYarn(
      [readFixture('yarn/berry-info.stdout')],
      readFixture('yarn/berry-npm-info.stdout'),
    )

    const result = await check(projectFor(yarn, cwd))

    expect(commands()).toEqual([
      INFO,
      [
        'npm',
        'info',
        'chalk',
        'dayjs',
        'debug',
        'ms',
        '--fields',
        'dist-tags,versions',
        '--json',
      ],
    ])
    expect(result).toEqual({
      chalk: {
        name: 'chalk',
        current: '4.0.0',
        wanted: '4.1.2',
        latest: '6.0.1',
      },
      dayjs: {
        name: 'dayjs',
        current: '1.11.9',
        wanted: '1.11.9',
        latest: '1.11.23',
      },
      debug: {
        name: 'debug',
        current: '4.3.1',
        wanted: '4.3.7',
        latest: '4.4.3',
      },
      ms: { name: 'ms', current: '2.1.1', wanted: '2.1.3', latest: '2.1.3' },
    })
  })

  it('reports the same packages with the node-modules linker', async () => {
    writeManifest({ dependencies: {} })
    fs.writeFileSync(
      path.join(cwd, '.yarnrc.yml'),
      'nodeLinker: node-modules\n',
    )
    mockYarn(
      [readFixture('yarn/berry-node-modules-info.stdout')],
      readFixture('yarn/berry-node-modules-npm-info.stdout'),
    )

    const result = await check(projectFor(yarn, cwd))

    expect(Object.keys(result)).toEqual([
      'chalk',
      'commander',
      'dayjs',
      'debug',
      'lodash',
      'ms',
      'semver',
      'uuid',
    ])
    expect(result.semver).toEqual({
      name: 'semver',
      current: '7.5.0',
      wanted: '7.8.5',
      latest: '7.8.5',
    })
    expect(result.lodash).toMatchObject({
      current: '4.17.20',
      wanted: '4.17.20',
    })
  })

  it('reports one entry per package per workspace, owners from the workspace paths', async () => {
    writeBerryWorkspace(cwd)
    mockYarn(
      [readFixture('yarn/berry-workspace-info.stdout')],
      readFixture('yarn/berry-workspace-npm-info.stdout'),
    )

    const result = await check(projectFor(yarn, cwd))

    expect(result).toEqual(foldWorkspaceEntries(WORKSPACE_ENTRIES))
    expect(commands()[0]).toEqual(INFO)
  })

  it('keys an npm alias by its manifest name and asks the registry for the target', async () => {
    writeManifest({
      dependencies: {
        '@sindresorhus/is': '^4.0.0',
        dj: 'npm:dayjs@^1.11.9',
        local: 'link:./local',
      },
      devDependencies: { typescript: '^5.4.0' },
    })
    mockYarn(
      [readFixture('yarn/berry-special-info.stdout')],
      readFixture('yarn/berry-special-npm-info.stdout'),
    )

    const result = await check(projectFor(yarn, cwd))

    expect(commands()[1].slice(0, 5)).toEqual([
      'npm',
      'info',
      '@sindresorhus/is',
      'dayjs',
      'typescript',
    ])
    expect(Object.keys(result)).toEqual([
      '@sindresorhus/is',
      'dj',
      'typescript',
    ])
    expect(result.dj).toEqual({
      name: 'dj',
      current: '1.11.9',
      wanted: '1.11.23',
      latest: '1.11.23',
    })
    // The patch: descriptor's npm range is what is compared, not the locator.
    expect(result.typescript).toMatchObject({
      current: '5.4.5',
      wanted: '5.9.3',
    })
  })

  it('reports nothing outdated without asking the registry when there are no dependencies', async () => {
    writeManifest({})
    mockYarn([readFixture('yarn/berry-info-empty.stdout')], '')

    await expect(check(projectFor(yarn, cwd))).resolves.toEqual({})
    expect(commands()).toEqual([INFO])
  })

  it('fails discovery when a workspace project lists no workspaces', async () => {
    // Only package lines: the output wasn't understood, not "up to date".
    writeManifest({ dependencies: { ms: '2.1.1' }, workspaces: ['packages/*'] })
    mockedRunProcess.mockResolvedValue({
      stdout: readFixture('yarn/berry-info.stdout')
        .split('\n')
        .filter((line) => !line.includes('@workspace:'))
        .join('\n'),
      stderr: '',
    })

    await expect(check(projectFor(yarn, cwd))).rejects.toMatchObject({
      step: 'discover',
      message: 'yarn info -A --json listed no workspaces',
    })
  })

  it('fails discovery when yarn info fails', async () => {
    writeManifest({ dependencies: { ms: '2.1.1' } })
    mockedRunProcess.mockRejectedValue(
      exitError(1, readFixture('yarn/berry-info-error.stdout'), ''),
    )

    await expect(check(projectFor(yarn, cwd))).rejects.toMatchObject({
      step: 'discover',
      message: expect.stringContaining('run "yarn install"'),
    })
  })

  it('fails discovery when the registry lookup fails', async () => {
    writeManifest({ dependencies: { ms: '2.1.1' } })
    mockedRunProcess
      .mockResolvedValueOnce({
        stdout: readFixture('yarn/berry-info.stdout'),
        stderr: '',
      })
      .mockRejectedValueOnce(
        exitError(1, readFixture('yarn/berry-npm-info-not-found.stdout'), ''),
      )

    await expect(check(projectFor(yarn, cwd))).rejects.toMatchObject({
      step: 'discover',
      message: expect.stringContaining('Package not found'),
    })
  })

  it('fails discovery when the registry answers for fewer packages than were asked', async () => {
    writeManifest({ dependencies: { ms: '2.1.1' } })
    const withoutMs = readFixture('yarn/berry-npm-info.stdout')
      .split('\n')
      .filter((line) => !line.startsWith('{"name":"ms"'))
      .join('\n')
    mockYarn([readFixture('yarn/berry-info.stdout')], withoutMs)

    await expect(check(projectFor(yarn, cwd))).rejects.toMatchObject({
      step: 'discover',
      message: 'yarn npm info printed nothing for ms',
    })
  })
})

describe('update with yarn berry', () => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-berry-update-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  const readJson = (file: string) =>
    JSON.parse(fs.readFileSync(path.join(cwd, file), 'utf8'))

  const BENCH = {
    packageManager: 'yarn@4.12.0',
    dependencies: {
      chalk: '^4.0.0',
      commander: '^11.0.0',
      dayjs: '1.11.9',
      debug: '~4.3.1',
      lodash: '4.17.20',
      ms: '2.1.1',
      semver: '^7.5.0',
      uuid: '~9.0.0',
    },
  }

  const writeBench = () =>
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(BENCH))

  const mockBench = (updated = true) =>
    mockYarn(
      [
        readFixture('yarn/berry-node-modules-info.stdout'),
        readFixture(
          updated
            ? 'yarn/berry-node-modules-info-updated.stdout'
            : 'yarn/berry-node-modules-info.stdout',
        ),
      ],
      readFixture('yarn/berry-node-modules-npm-info.stdout'),
    )

  it('re-resolves in-range packages with `up -R`, leaving package.json alone', async () => {
    writeBench()
    mockBench()

    const results = await update(projectFor(yarn, cwd))

    expect(commands()).toEqual([
      INFO,
      expect.arrayContaining(['npm', 'info']),
      ['up', '-R', 'chalk', 'commander', 'debug', 'semver', 'uuid'],
      INFO,
    ])
    expect(readJson('package.json')).toEqual(BENCH)
    expect(results.filter((r) => r.updated).map((r) => r.name)).toEqual([
      'chalk',
      'commander',
      'debug',
      'semver',
      'uuid',
    ])
  })

  it('reads the installed versions from yarn info, so PnP needs no node_modules', async () => {
    writeBench()
    mockBench(false)

    const results = await update(projectFor(yarn, cwd))

    // The lockfile still holds chalk 4.0.0: not applied, though yarn exited 0.
    expect(results.find((r) => r.name === 'chalk')).toMatchObject({
      updated: false,
      reason: 'not applied by yarn (installed 4.0.0)',
    })
    expect(fs.existsSync(path.join(cwd, 'node_modules'))).toBe(false)
  })

  it('fails the apply step when yarn info is unreadable after apply', async () => {
    writeBench()
    mockYarn(
      [readFixture('yarn/berry-node-modules-info.stdout'), 'not json'],
      readFixture('yarn/berry-node-modules-npm-info.stdout'),
    )

    await expect(update(projectFor(yarn, cwd))).rejects.toMatchObject({
      step: 'apply',
      message: "yarn info (after apply) printed a line it can't read",
    })
  })

  it('writes a beyond-range spec into the manifest, installs, then re-resolves the rest', async () => {
    writeBench()
    mockBench()

    await update(projectFor(yarn, cwd, { beyondRange: 'major' }))

    expect(readJson('package.json').dependencies).toMatchObject({
      chalk: '^6.0.1',
      dayjs: '1.11.23',
      debug: '~4.4.3',
      uuid: '~14.0.3',
    })
    // Only semver's range allows its latest.
    expect(commands().slice(2)).toEqual([
      ['install', '--no-immutable'],
      ['up', '-R', 'semver'],
      INFO,
    ])
  })

  it('skips `up` when every package moves past its range', async () => {
    writeBench()
    mockBench()

    await update(projectFor(yarn, cwd, { beyondRange: 'major' }), {
      targetPackages: ['dayjs'],
    })

    expect(commands().slice(2)).toEqual([['install', '--no-immutable'], INFO])
  })

  it('writes each owning manifest of a workspace and re-resolves project-wide', async () => {
    writeBerryWorkspace(cwd)
    mockYarn(
      [
        readFixture('yarn/berry-workspace-info.stdout'),
        readFixture('yarn/berry-workspace-info-updated.stdout'),
      ],
      readFixture('yarn/berry-workspace-npm-info.stdout'),
    )

    await update(projectFor(yarn, cwd, { beyondRange: 'major' }))

    expect(readJson('package.json').dependencies).toEqual({
      dayjs: '1.11.23',
      ms: '~2.1.1',
    })
    expect(readJson('packages/a/package.json').dependencies).toEqual({
      ms: '2.1.3',
    })
    expect(readJson('packages/b/package.json').dependencies).toEqual({
      debug: '~4.4.3',
      dayjs: '^1.11.9',
    })
    expect(commands().slice(2)).toEqual([
      ['install', '--no-immutable'],
      ['up', '-R', 'dayjs', 'ms'],
      INFO,
    ])
  })

  it('checks each workspace row against its own workspace in the installed versions', async () => {
    writeBerryWorkspace(cwd)
    mockYarn(
      [
        readFixture('yarn/berry-workspace-info.stdout'),
        readFixture('yarn/berry-workspace-info-updated.stdout'),
      ],
      readFixture('yarn/berry-workspace-npm-info.stdout'),
    )

    const results = await update(projectFor(yarn, cwd))

    expect(commands()).toEqual([
      INFO,
      expect.arrayContaining(['npm', 'info']),
      ['up', '-R', 'dayjs', 'debug', 'ms'],
      INFO,
    ])
    expect(
      results.filter((r) => r.updated).map((r) => `${r.workspace}:${r.name}`),
    ).toEqual(['packages/b:dayjs', 'packages/b:debug', '.:ms'])
  })

  it('fails apply with the manifest flagged as written when install fails', async () => {
    writeBench()
    mockedRunProcess.mockImplementation(async (_command, args) => {
      if (args[0] === 'info') {
        return {
          stdout: readFixture('yarn/berry-node-modules-info.stdout'),
          stderr: '',
        }
      }
      if (args[0] === 'npm') {
        return {
          stdout: readFixture('yarn/berry-node-modules-npm-info.stdout'),
          stderr: '',
        }
      }
      throw exitError(1, '➤ YN0001: │ Error: install failed', '')
    })

    await expect(
      update(projectFor(yarn, cwd, { beyondRange: 'major' })),
    ).rejects.toMatchObject({ step: 'apply', manifestWritten: true })
  })

  it('fails apply without the manifest flagged when `up` fails', async () => {
    writeBench()
    mockedRunProcess.mockImplementation(async (_command, args) => {
      if (args[0] === 'info') {
        return {
          stdout: readFixture('yarn/berry-node-modules-info.stdout'),
          stderr: '',
        }
      }
      if (args[0] === 'npm') {
        return {
          stdout: readFixture('yarn/berry-node-modules-npm-info.stdout'),
          stderr: '',
        }
      }
      throw exitError(1, '➤ YN0001: │ Error: up failed', '')
    })

    await expect(update(projectFor(yarn, cwd))).rejects.toMatchObject({
      step: 'apply',
      manifestWritten: false,
    })
  })
})
