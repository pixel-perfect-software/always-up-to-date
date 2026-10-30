import { Command } from 'commander'

jest.mock('@/detectPackageManager', () => ({
  __esModule: true,
  default: jest.fn(),
}))

jest.mock('@/pipeline', () => ({
  findOutdated: jest.fn(),
  plan: jest.fn(),
  refuseMemberApply: jest.fn(),
  update: jest.fn(),
}))

jest.mock('@/project', () => {
  const actual = jest.requireActual<typeof import('@/project')>('@/project')
  return { ...actual, openProject: jest.fn(actual.openProject) }
})
jest.mock('@/utils/logger')
jest.mock('@/utils/config')
jest.mock('@inquirer/prompts', () => ({
  checkbox: jest.fn(),
}))

import { checkbox } from '@inquirer/prompts'
import updateCommand from '@/commands/update'
import detectPackageManager from '@/detectPackageManager'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import { findOutdated, plan, refuseMemberApply, update } from '@/pipeline'
import { openProject } from '@/project'
import { StepError } from '@/stepError'
import logger from '@/utils/logger'

const mockDetectPackageManager = jest.mocked(detectPackageManager)
const mockPlan = jest.mocked(plan)
const mockCheckbox = jest.mocked(checkbox)

const mockUpdatePackages = jest.mocked(update)
const mockCheckPackageVersions = jest.mocked(findOutdated)

describe('update command', () => {
  let program: Command

  beforeEach(() => {
    mockDetectPackageManager.mockReturnValue('npm')
    mockUpdatePackages.mockReset()
    mockCheckPackageVersions.mockReset()
    mockPlan.mockReset().mockResolvedValue([])

    program = new Command()
    program.exitOverride()
    updateCommand(program)
  })

  it('asks openProject for the cache, and --no-cache turns it off', async () => {
    mockUpdatePackages.mockResolvedValue([])

    await program.parseAsync(['node', 'test', 'update'])
    await program.parseAsync(['node', 'test', 'update', '--no-cache'])

    expect(
      jest.mocked(openProject).mock.calls.map(([, o]) => o?.cache),
    ).toEqual([true, false])
  })

  it('registers the update command', () => {
    const cmd = program.commands.find((c) => c.name() === 'update')
    expect(cmd).toBeDefined()
  })

  it('runs the update pipeline on action', async () => {
    mockUpdatePackages.mockResolvedValue([])
    await program.parseAsync(['node', 'test', 'update'])
    expect(mockUpdatePackages).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: npm, root: expect.any(String) }),
      {
        targetPackages: undefined,
      },
    )
  })

  it('passes target packages when specified', async () => {
    mockUpdatePackages.mockResolvedValue([])
    await program.parseAsync(['node', 'test', 'update', 'react', 'lodash'])
    expect(mockUpdatePackages).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: npm, root: expect.any(String) }),
      {
        targetPackages: ['react', 'lodash'],
      },
    )
  })

  it('uses the manager --pm names, with package names around it', async () => {
    mockDetectPackageManager.mockReturnValueOnce('bun')
    mockUpdatePackages.mockResolvedValue([])

    await program.parseAsync(['node', 'test', 'update', 'react', '--pm', 'bun'])

    expect(mockDetectPackageManager).toHaveBeenCalledWith(
      expect.any(String),
      'bun',
      { from: expect.any(String), cwd: expect.any(String) },
    )
    expect(mockUpdatePackages).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: bun }),
      { targetPackages: ['react'] },
    )
  })

  it('runs dry-run without applying', async () => {
    mockCheckPackageVersions.mockResolvedValue({
      react: {
        name: 'react',
        current: '18.0.0',
        wanted: '18.0.0',
        latest: '18.0.1',
      },
    })
    mockPlan.mockResolvedValue([
      {
        name: 'react',
        current: '18.0.0',
        wanted: '18.0.0',
        latest: '18.0.1',
        updateType: 'patch',
        updated: true,
      },
    ])

    await program.parseAsync(['node', 'test', 'update', '--dry-run'])

    expect(mockCheckPackageVersions).toHaveBeenCalled()
    expect(mockUpdatePackages).not.toHaveBeenCalled()
  })

  it('outputs JSON in dry-run mode when --json is passed', async () => {
    const results = [
      {
        name: 'react',
        current: '18.0.0',
        wanted: '18.0.0',
        latest: '18.0.1',
        updateType: 'patch' as const,
        updated: true,
      },
    ]
    mockCheckPackageVersions.mockResolvedValue({
      react: {
        name: 'react',
        current: '18.0.0',
        wanted: '18.0.0',
        latest: '18.0.1',
      },
    })
    mockPlan.mockResolvedValue(results)

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation()
    await program.parseAsync(['node', 'test', 'update', '--dry-run', '--json'])

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(results, null, 2))
    consoleSpy.mockRestore()
  })

  it('outputs JSON after update when --json is passed', async () => {
    const results = [
      {
        name: 'react',
        current: '18.0.0',
        wanted: '18.0.0',
        latest: '18.0.1',
        updateType: 'patch' as const,
        updated: true,
      },
    ]
    mockUpdatePackages.mockResolvedValue(results)

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation()
    await program.parseAsync(['node', 'test', 'update', '--json'])

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(results, null, 2))
    consoleSpy.mockRestore()
  })

  it('dry-run exits early when no outdated packages', async () => {
    mockCheckPackageVersions.mockResolvedValue({})

    await program.parseAsync(['node', 'test', 'update', '--dry-run'])

    expect(mockPlan).not.toHaveBeenCalled()
    expect(mockUpdatePackages).not.toHaveBeenCalled()
  })

  it('interactive mode discovers once and applies the selection with that result', async () => {
    const outdated = {
      react: {
        name: 'react',
        current: '18.0.0',
        wanted: '18.0.0',
        latest: '18.0.1',
      },
      lodash: {
        name: 'lodash',
        current: '4.17.20',
        wanted: '4.17.20',
        latest: '4.17.21',
      },
    }
    mockCheckPackageVersions.mockResolvedValue(outdated)
    mockPlan.mockResolvedValue([
      {
        name: 'react',
        current: '18.0.0',
        wanted: '18.0.0',
        latest: '18.0.1',
        updateType: 'patch',
        updated: true,
      },
      {
        name: 'lodash',
        current: '4.17.20',
        wanted: '4.17.20',
        latest: '4.17.21',
        updateType: 'patch',
        updated: true,
      },
    ])
    mockCheckbox.mockResolvedValue(['react'])
    mockUpdatePackages.mockResolvedValue([])

    await program.parseAsync(['node', 'test', 'update', '--interactive'])

    expect(mockCheckPackageVersions).toHaveBeenCalledTimes(1)
    expect(mockUpdatePackages).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: npm, root: expect.any(String) }),
      {
        targetPackages: ['react'],
        discovered: outdated,
      },
    )
  })

  describe('in a workspace project', () => {
    const row = (name: string, workspace: string, updated = true) => ({
      name,
      workspace,
      current: '1.0.0',
      wanted: '1.0.1',
      latest: '1.0.1',
      target: updated ? '1.0.1' : undefined,
      updateType: 'patch' as const,
      updated,
      reason: updated ? undefined : 'held',
    })

    it('interactive mode offers one choice per package, listing its manifests', async () => {
      mockCheckPackageVersions.mockResolvedValue({
        ms: { name: 'ms', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
      })
      mockPlan.mockResolvedValue([row('ms', '.'), row('ms', 'packages/a')])
      mockCheckbox.mockResolvedValue(['ms'])
      mockUpdatePackages.mockResolvedValue([])

      await program.parseAsync(['node', 'test', 'update', '--interactive'])

      const { choices } = mockCheckbox.mock.calls[0][0]
      expect(choices).toEqual([
        {
          name: 'ms: (root) 1.0.0 → 1.0.1 (patch), packages/a 1.0.0 → 1.0.1 (patch)',
          value: 'ms',
          checked: true,
        },
      ])
    })

    it('refuses -i from a member before discovering or prompting (#123)', async () => {
      jest.mocked(refuseMemberApply).mockImplementationOnce(() => {
        throw new StepError('apply', 'update runs from the workspace root')
      })

      await program.parseAsync(['node', 'test', 'update', '--interactive'])

      expect(process.exitCode).toBe(1)
      expect(mockCheckPackageVersions).not.toHaveBeenCalled()
      expect(mockCheckbox).not.toHaveBeenCalled()
      process.exitCode = undefined
    })

    it('carries the workspace on the dry-run skipped rows', async () => {
      mockCheckPackageVersions.mockResolvedValue({
        ms: { name: 'ms', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
      })
      mockPlan.mockResolvedValue([row('ms', 'packages/a', false)])

      await program.parseAsync(['node', 'test', 'update', '--dry-run'])

      expect(logger.report).toHaveBeenCalledWith(
        [expect.objectContaining({ name: 'ms', workspace: 'packages/a' })],
        expect.any(String),
        'plan',
        { member: undefined },
      )
    })
  })
})
