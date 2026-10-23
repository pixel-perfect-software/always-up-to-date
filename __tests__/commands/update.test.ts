import { Command } from 'commander'

jest.mock('@/detectPackageManager', () => ({
  __esModule: true,
  default: jest.fn(),
}))

jest.mock('@/pipeline', () => ({
  check: jest.fn(),
  plan: jest.fn(),
  update: jest.fn(),
}))

jest.mock('@/utils/logger')
jest.mock('@/utils/config')
jest.mock('@/utils/registry', () => ({
  clearRegistryCache: jest.fn(),
  fetchReleaseTimes: jest.fn(),
}))
jest.mock('@inquirer/prompts', () => ({
  checkbox: jest.fn(),
}))

import { checkbox } from '@inquirer/prompts'
import updateCommand from '@/commands/update'
import detectPackageManager from '@/detectPackageManager'
import npm from '@/managers/npm'
import { check, plan, update } from '@/pipeline'

const mockDetectPackageManager = jest.mocked(detectPackageManager)
const mockPlan = jest.mocked(plan)
const mockCheckbox = jest.mocked(checkbox)

const mockUpdatePackages = jest.mocked(update)
const mockCheckPackageVersions = jest.mocked(check)

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

  it('registers the update command', () => {
    const cmd = program.commands.find((c) => c.name() === 'update')
    expect(cmd).toBeDefined()
  })

  it('runs the update pipeline on action', async () => {
    mockUpdatePackages.mockResolvedValue([])
    await program.parseAsync(['node', 'test', 'update'])
    expect(mockUpdatePackages).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: npm, cwd: expect.any(String) }),
      {
        targetPackages: undefined,
      },
    )
  })

  it('passes target packages when specified', async () => {
    mockUpdatePackages.mockResolvedValue([])
    await program.parseAsync(['node', 'test', 'update', 'react', 'lodash'])
    expect(mockUpdatePackages).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: npm, cwd: expect.any(String) }),
      {
        targetPackages: ['react', 'lodash'],
      },
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
      expect.objectContaining({ adapter: npm, cwd: expect.any(String) }),
      {
        targetPackages: ['react'],
        discovered: outdated,
      },
    )
  })
})
