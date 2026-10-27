import fs from 'fs'
import os from 'os'
import path from 'path'
import type { Pinning, RunManager } from '@/managers/adapter'
import { applyPinned } from '@/managers/pin'
import { StepError } from '@/stepError'
import { updatePNPMWorkspaceYAML } from '@/utils/files'
import { DEFAULT_SAVE_STYLE } from '@/utils/saveStyle'

describe('applyPinned (#147)', () => {
  let cwd: string

  const write = (file: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
    fs.writeFileSync(path.join(cwd, file), text)
  }
  const read = (file: string) => fs.readFileSync(path.join(cwd, file), 'utf8')

  /** A manager that records, per command, what the given files held when it ran. */
  const recorder = (files: string[]) => {
    const seen: { args: string[]; files: Record<string, string> }[] = []
    const run: RunManager = async (args) => {
      seen.push({
        args,
        files: Object.fromEntries(files.map((file) => [file, read(file)])),
      })
      return ''
    }
    return { run, seen }
  }

  const adapter = (pinning: Partial<Pinning> = {}) => ({
    name: 'npm' as const,
    saveStyle: () => DEFAULT_SAVE_STYLE,
    pinning: () => ({ install: ['install'], ...pinning }),
  })

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-pin-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('installs the exact version, then puts the manifest back byte for byte and installs again', async () => {
    const manifest =
      '{\n\t"dependencies": { "ms": "^2.0.0" },\n\t"peerDependencies": { "ms": ">=2" }\n}\n'
    write('package.json', manifest)
    const { run, seen } = recorder(['package.json'])

    await applyPinned(
      run,
      cwd,
      [{ path: '.', name: 'ms', version: '2.1.2', beyondRange: false }],
      adapter(),
    )

    expect(seen.map((s) => s.args)).toEqual([['install'], ['install']])
    expect(JSON.parse(seen[0].files['package.json']).dependencies.ms).toBe(
      '2.1.2',
    )
    expect(seen[1].files['package.json']).toBe(manifest)
    expect(read('package.json')).toBe(manifest)
  })

  it('moves a row past its range to the version, keeping its decorator', async () => {
    write('packages/a/package.json', '{"dependencies":{"dayjs":"~1.10.0"}}')
    write('package.json', '{"workspaces":["packages/*"]}')
    const { run, seen } = recorder(['packages/a/package.json'])

    await applyPinned(
      run,
      cwd,
      [
        {
          path: 'packages/a',
          name: 'dayjs',
          version: '1.11.5',
          beyondRange: true,
        },
      ],
      adapter(),
    )

    expect(
      JSON.parse(seen[0].files['packages/a/package.json']).dependencies.dayjs,
    ).toBe('1.11.5')
    expect(JSON.parse(read('packages/a/package.json')).dependencies.dayjs).toBe(
      '~1.11.5',
    )
  })

  it('pins and restores a catalog entry through the manager writer', async () => {
    const yaml = "packages:\n  - 'packages/*'\ncatalog:\n  ms: ^2.0.0\n"
    write('pnpm-workspace.yaml', yaml)
    write('package.json', '{"dependencies":{"ms":"catalog:"}}')
    const { run, seen } = recorder(['pnpm-workspace.yaml'])

    await applyPinned(
      run,
      cwd,
      [{ path: '.', name: 'ms', version: '2.1.2', beyondRange: false }],
      adapter({ writeCatalog: updatePNPMWorkspaceYAML }),
    )

    expect(seen[0].files['pnpm-workspace.yaml']).toContain('  ms: 2.1.2\n')
    expect(read('pnpm-workspace.yaml')).toBe(yaml)
    expect(read('package.json')).toBe('{"dependencies":{"ms":"catalog:"}}')
  })

  it('relocks each restored spec against its pinned version before the second install', async () => {
    write('package.json', '{"dependencies":{"ms":"^2.0.0"}}')
    const order: string[] = []
    const relock = jest.fn(() => {
      order.push('relock')
    })
    const run: RunManager = async (args) => {
      order.push(args.join(' '))
      return ''
    }

    await applyPinned(
      run,
      cwd,
      [{ path: '.', name: 'ms', version: '2.1.2', beyondRange: false }],
      adapter({ relock }),
    )

    expect(order).toEqual(['install', 'relock', 'install'])
    expect(relock).toHaveBeenCalledWith(cwd, [
      { workspace: '.', name: 'ms', range: '^2.0.0', installed: '2.1.2' },
    ])
  })

  it('fails apply naming the lockfile when the relock has nowhere to write', async () => {
    write('package.json', '{"dependencies":{"ms":"^2.0.0"}}')
    const relock = () => {
      throw new Error('yarn.lock: no key for ms@2.1.2')
    }

    const failure = applyPinned(
      async () => '',
      cwd,
      [{ path: '.', name: 'ms', version: '2.1.2', beyondRange: false }],
      adapter({ relock }),
    )

    await expect(failure).rejects.toThrow(StepError)
    await expect(failure).rejects.toMatchObject({
      step: 'apply',
      manifestWritten: true,
      message: expect.stringContaining('yarn.lock: no key for ms@2.1.2'),
    })
  })
})
