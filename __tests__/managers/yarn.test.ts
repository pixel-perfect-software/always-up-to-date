import fs from 'fs'
import os from 'os'
import path from 'path'
import yarn from '@/managers/yarn'
import { update } from '@/pipeline'
import type { AlwaysUpToDateConfig } from '@/types'
import { foldWorkspaceEntries } from '@/utils/workspaceRows'
import {
  capturedRegistry,
  exitError,
  installPackages,
  projectFor,
  readFixture,
} from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { logger, runProcess } from '@/utils'

const mockedRunProcess = jest.mocked(runProcess)

describe('update with yarn', () => {
  let cwd: string

  // Most cases here move exact pins, which needs a beyond-range level.
  const movePins = { allowMinorUpdates: true }

  const writeProject = (
    manifest: Record<string, unknown>,
    extraFiles: Record<string, string> = {},
  ) => {
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify(manifest, null, 2),
    )
    for (const [name, content] of Object.entries(extraFiles)) {
      fs.writeFileSync(path.join(cwd, name), content)
    }
  }

  const readManifest = () =>
    JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'))

  // When yarn/v1-upgrade.* was captured, so no version drifts with the registry.
  const AS_OF = '2026-10-23T08:59:22-03:00'

  // A project whose node_modules holds `installed`, discovered natively.
  const nativeProject = (
    installed: Record<string, string>,
    config: Partial<AlwaysUpToDateConfig> = {},
  ) => {
    installPackages(cwd, '.', installed)
    return projectFor(
      yarn,
      cwd,
      config,
      capturedRegistry(Object.keys(installed), { asOf: AS_OF }),
    )
  }

  const applied = (stdout: string, stderr = '') =>
    mockedRunProcess.mockResolvedValue({ stdout, stderr })

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-yarn-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  // A v1 workspace whose member @autd/b holds the yarn-C7 capture's `before`
  // manifest (kleur only in devDependencies); `afterFixture` is what the mocked
  // `workspace @autd/b upgrade` leaves on disk, as captured from yarn 1.22.22.
  const memberWithDevDependency = (afterFixture: string) => {
    writeProject({ name: 'ws-root', private: true, workspaces: ['packages/*'] })
    const file = path.join(cwd, 'packages', 'b', 'package.json')
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const before = readFixture('yarn/v1-member-upgrade-dev.before.json')
    fs.writeFileSync(file, before)
    mockedRunProcess.mockImplementation(async (_pm, args) => {
      if (args[0] === 'workspace') {
        fs.writeFileSync(file, readFixture(afterFixture))
      }
      return { stdout: '', stderr: '' }
    })
    return { file, before }
  }

  const memberRow = (
    name: string,
    current: string,
    wanted: string,
    latest: string,
  ) => ({
    name,
    workspace: 'packages/b',
    current,
    wanted,
    latest,
  })

  it("upgrades a member's devDependencies in one command and keeps them out of dependencies", async () => {
    // yarn 1.22.22 has no -D / -O on `upgrade`: commander takes the next
    // descriptor as the flag's value and everything is upgraded (yarn-C11).
    // Without a flag, yarn copies the devDependency into `dependencies`
    // (yarn-C7), so autd puts the manifest's bytes back.
    const { file, before } = memberWithDevDependency(
      'yarn/v1-member-upgrade-dev.after.json',
    )

    await update(projectFor(yarn, cwd), {
      discovered: foldWorkspaceEntries([
        memberRow('commander', '11.0.0', '11.1.0', '14.0.2'),
        memberRow('debug', '4.3.1', '4.3.7', '4.4.3'),
        memberRow('kleur', '3.0.0', '3.0.3', '4.1.5'),
      ]),
    })

    expect(mockedRunProcess.mock.calls.map(([, args]) => args)).toEqual([
      [
        'workspace',
        '@autd/b',
        'upgrade',
        'commander@^11.0.0',
        'debug@~4.3.1',
        'kleur@~3.0.0',
      ],
      ['install', '--check-files'],
    ])
    expect(fs.readFileSync(file, 'utf8')).toBe(before)
  })

  it("writes a member devDependency's spec past its range, and nothing in dependencies", async () => {
    const { file } = memberWithDevDependency(
      'yarn/v1-member-upgrade-dev-latest.after.json',
    )

    await update(projectFor(yarn, cwd, { rules: { kleur: 'latest' } }), {
      discovered: foldWorkspaceEntries([
        memberRow('kleur', '3.0.0', '3.0.3', '4.1.5'),
      ]),
    })

    const manifest = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(manifest.devDependencies).toEqual({ kleur: '~4.1.5' })
    expect(manifest.dependencies).toEqual({
      commander: '^11.0.0',
      debug: '~4.3.1',
    })
    expect(mockedRunProcess.mock.calls.map(([, args]) => args)).toEqual([
      ['workspace', '@autd/b', 'upgrade', 'kleur@~4.1.5'],
      ['install', '--check-files'],
    ])
  })

  it('flags the manifest as written when install fails after a beyond-range write', async () => {
    memberWithDevDependency('yarn/v1-member-upgrade-dev-latest.after.json')
    mockedRunProcess.mockImplementation(async (_pm, args) => {
      if (args[0] === 'install') throw exitError(1, '', 'boom')
      return { stdout: '', stderr: '' }
    })

    const error = await update(
      projectFor(yarn, cwd, { rules: { kleur: 'latest' } }),
      {
        discovered: foldWorkspaceEntries([
          memberRow('kleur', '3.0.0', '3.0.3', '4.1.5'),
        ]),
      },
    ).catch((e: unknown) => e)

    expect(error).toMatchObject({ step: 'apply', manifestWritten: true })
  })

  it('keeps the current spec for an in-range update', async () => {
    writeProject({ dependencies: { dayjs: '^1.11.9' } })
    applied('')
    await update(nativeProject({ dayjs: '1.11.9' }), {
      targetPackages: ['dayjs'],
    })
    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'dayjs@^1.11.9'],
      expect.anything(),
    )
  })

  it('runs `yarn upgrade` on v1 with a descriptor that keeps an exact pin exact', async () => {
    writeProject({ dependencies: { dayjs: '1.11.9' } })
    // yarn moves dayjs, so the post-apply check keeps it updated.
    mockedRunProcess.mockImplementation(async () => {
      installPackages(cwd, '.', { dayjs: '1.11.23' })
      return {
        stdout: readFixture('yarn/v1-upgrade.stdout'),
        stderr: readFixture('yarn/v1-upgrade.stderr'),
      }
    })

    const results = await update(nativeProject({ dayjs: '1.11.9' }, movePins), {
      targetPackages: ['dayjs'],
    })

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'dayjs@1.11.23'],
      expect.objectContaining({ cwd }),
    )
    expect(results.find((r) => r.name === 'dayjs')?.updated).toBe(true)
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('logs the Node deprecation warning on stderr at debug level, not as an error', async () => {
    writeProject({ dependencies: { dayjs: '1.11.9' } })
    applied(
      readFixture('yarn/v1-upgrade.stdout'),
      readFixture('yarn/v1-upgrade.stderr'),
    )

    await update(nativeProject({ dayjs: '1.11.9' }, movePins), {
      targetPackages: ['dayjs'],
    })

    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('[DEP0169] DeprecationWarning'),
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('leaves package.json for yarn to write, since v1 rejects a pre-written manifest', async () => {
    // Real yarn v1 output when the manifest is edited before `upgrade`.
    expect(readFixture('yarn/v1-upgrade-prewritten.stderr')).toContain(
      'Outdated lockfile',
    )
    const manifest = { dependencies: { dayjs: '1.11.9' } }
    writeProject(manifest)
    applied(readFixture('yarn/v1-upgrade.stdout'))

    await update(nativeProject({ dayjs: '1.11.9' }, movePins), {
      targetPackages: ['dayjs'],
    })

    expect(readManifest()).toEqual(manifest)
  })

  it('keeps a caret range a caret range', async () => {
    writeProject({ dependencies: { ms: '^1.0.0' } })
    applied(readFixture('yarn/v1-upgrade.stdout'))

    await update(nativeProject({ ms: '1.0.0' }, { beyondRange: 'major' }), {
      targetPackages: ['ms'],
    })

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'ms@^2.1.3'],
      expect.anything(),
    )
  })

  it('takes the spec from devDependencies too', async () => {
    writeProject({ devDependencies: { dayjs: '~1.10.0' } })
    applied(readFixture('yarn/v1-upgrade.stdout'))

    await update(nativeProject({ dayjs: '1.10.0' }, movePins), {
      targetPackages: ['dayjs'],
    })

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'dayjs@~1.11.23'],
      expect.anything(),
    )
  })

  it('trusts packageManager yarn@1 over a stray .yarnrc.yml', async () => {
    writeProject(
      { packageManager: 'yarn@1.22.22', dependencies: { dayjs: '1.11.9' } },
      { '.yarnrc.yml': '' },
    )
    applied(readFixture('yarn/v1-upgrade.stdout'))

    await update(nativeProject({ dayjs: '1.11.9' }, movePins), {
      targetPackages: ['dayjs'],
    })

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'dayjs@1.11.23'],
      expect.anything(),
    )
  })

  it('surfaces a failed apply command as an error', async () => {
    writeProject({ dependencies: { dayjs: '1.11.9' } })
    mockedRunProcess.mockRejectedValueOnce(
      // Real v1 output for the old `yarn update` command.
      exitError(
        1,
        readFixture('yarn/v1-update.stdout'),
        readFixture('yarn/v1-update.stderr'),
      ),
    )

    await expect(
      update(nativeProject({ dayjs: '1.11.9' }, movePins), {
        targetPackages: ['dayjs'],
      }),
    ).rejects.toMatchObject({
      step: 'apply',
      manifestWritten: false,
      message: expect.stringContaining('Command "update" not found'),
    })
  })

  it('does not hand yarn a package the root manifest does not list', async () => {
    // yarn v1 `upgrade ms@2.1.3` at a workspace root adds ms to the root
    // dependencies when only a member declares it.
    writeProject({ dependencies: { dayjs: '1.11.9' } })
    applied(readFixture('yarn/v1-upgrade.stdout'))

    // ms is outdated in a member only; this run asks about it at the root.
    await update(projectFor(yarn, cwd, movePins), {
      targetPackages: ['dayjs', 'ms'],
      discovered: {
        dayjs: {
          name: 'dayjs',
          current: '1.11.9',
          wanted: '1.11.9',
          latest: '1.11.23',
        },
        ms: { name: 'ms', current: '2.1.2', wanted: '2.1.2', latest: '2.1.3' },
      },
    })

    expect(mockedRunProcess).toHaveBeenLastCalledWith(
      'yarn',
      ['upgrade', 'dayjs@1.11.23'],
      expect.anything(),
    )
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('ms'))
  })
})
