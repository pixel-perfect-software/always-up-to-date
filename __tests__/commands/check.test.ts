import { Command } from 'commander'
import {
  beforeEach,
  describe,
  expect,
  fn,
  it,
  mock,
  mocked,
  requireActual,
  spyOn,
} from 'provino'

mock('@/detectPackageManager', () => ({
  __esModule: true,
  default: fn().mockReturnValue('npm'),
}))

mock('@/pipeline', () => ({
  check: fn(),
  findOutdated: fn(),
  plan: fn(),
}))

mock('@/project', () => {
  const actual = requireActual<typeof import('@/project')>('@/project')
  return { ...actual, openProject: fn(actual.openProject) }
})
mock('@/utils/logger')
mock('@/utils/config')

import checkCommand from '@/commands/check'
import detectPackageManager from '@/detectPackageManager'
import npm from '@/managers/npm'
import yarn from '@/managers/yarn'
import { check, findOutdated, plan } from '@/pipeline'
import { openProject } from '@/project'
import packageJson from '../../package.json'
import { validateOutput } from '../fixtures/outputSchema'
import { reasonFor } from '../fixtures/reasons'

const mockCheckPackageVersions = mocked(check)

describe('check command', () => {
  let program: Command

  beforeEach(() => {
    program = new Command()
    program.exitOverride()
    checkCommand(program)
    mockCheckPackageVersions.mockReset()
  })

  it('asks openProject for the cache, and --no-cache turns it off', async () => {
    mockCheckPackageVersions.mockResolvedValue({})

    await program.parseAsync(['node', 'test', 'check'])
    await program.parseAsync(['node', 'test', 'check', '--no-cache'])

    expect(mocked(openProject).mock.calls.map(([, o]) => o?.cache)).toEqual([
      true,
      false,
    ])
  })

  it('registers the check command', () => {
    const cmd = program.commands.find((c) => c.name() === 'check')
    expect(cmd).toBeDefined()
  })

  it("runs the check pipeline with the detected manager's adapter", async () => {
    mockCheckPackageVersions.mockResolvedValue({})
    await program.parseAsync(['node', 'test', 'check'])
    expect(mockCheckPackageVersions).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: npm, root: expect.any(String) }),
      { next: 'autd update' },
    )
  })

  it("repeats the run's --pm and --no-cache in the next-step command", async () => {
    mockCheckPackageVersions.mockResolvedValue({})
    await program.parseAsync([
      'node',
      'test',
      'check',
      '--pm',
      'npm',
      '--no-cache',
    ])
    expect(mockCheckPackageVersions).toHaveBeenCalledWith(expect.anything(), {
      next: 'autd update --pm npm --no-cache',
    })
  })

  it('uses the manager --pm names', async () => {
    mocked(detectPackageManager).mockReturnValueOnce('yarn')
    mockCheckPackageVersions.mockResolvedValue({})

    await program.parseAsync(['node', 'test', 'check', '--pm', 'yarn'])

    expect(detectPackageManager).toHaveBeenCalledWith(
      expect.any(String),
      'yarn',
      { from: expect.any(String), cwd: expect.any(String) },
    )
    expect(mockCheckPackageVersions).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: yarn }),
      { next: 'autd update --pm yarn' },
    )
  })

  it('rejects a --pm autd does not support', async () => {
    // commander prints the error before throwing it; keep the test output clean.
    program.configureOutput({ writeErr: fn() })

    await expect(
      program.parseAsync(['node', 'test', 'check', '--pm', 'deno']),
    ).rejects.toThrow(
      "option '--pm <manager>' argument 'deno' is invalid. Allowed choices are npm, yarn, pnpm, bun.",
    )
    expect(mockCheckPackageVersions).not.toHaveBeenCalled()
  })

  it('--json prints the planned rows as a versioned document, not the pipeline check', async () => {
    const outdated = {
      react: {
        name: 'react',
        current: '18.0.0',
        wanted: '18.0.0',
        latest: '18.0.1',
      },
    }
    mocked(findOutdated).mockResolvedValue(outdated)
    mocked(plan).mockResolvedValue([
      {
        ...outdated.react,
        updateType: 'patch',
        updated: false,
        reason: reasonFor('patch beyond the range', 'outside-range'),
      },
    ])

    const consoleSpy = spyOn(console, 'log').mockImplementation(() => undefined)
    await program.parseAsync(['node', 'test', 'check', '--json'])

    const document = JSON.parse(String(consoleSpy.mock.calls[0][0]))
    consoleSpy.mockRestore()
    validateOutput(document)
    expect(document).toMatchObject({
      version: 1,
      autd: packageJson.version,
      command: 'check',
      phase: 'plan',
      manager: 'npm',
      member: null,
      rows: [{ name: 'react', target: null, outcome: 'held' }],
    })
    expect(mockCheckPackageVersions).not.toHaveBeenCalled()
  })
})
