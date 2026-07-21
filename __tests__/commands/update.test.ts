import { Command } from 'commander'

jest.mock('@/detectPackageManager', () => ({
  __esModule: true,
  default: jest.fn(),
}))

jest.mock('@/managers', () => ({
  PackageManager: jest.fn(),
}))

jest.mock('@/utils/logger')
jest.mock('@/utils/config')
jest.mock('@/utils/registry', () => ({
  clearRegistryCache: jest.fn(),
  fetchReleaseTimes: jest.fn(),
}))
jest.mock('@/utils/filterPackages', () => ({
  __esModule: true,
  default: jest.fn(),
}))

import updateCommand from '@/commands/update'
import detectPackageManager from '@/detectPackageManager'
import { PackageManager } from '@/managers'
import filterPackages from '@/utils/filterPackages'

const mockDetectPackageManager = jest.mocked(detectPackageManager)
const mockPackageManager = jest.mocked(PackageManager)
const mockFilterPackages = jest.mocked(filterPackages)

const mockUpdatePackages = jest.fn()
const mockCheckPackageVersions = jest.fn()

describe('update command', () => {
  let program: Command

  beforeEach(() => {
    mockDetectPackageManager.mockReturnValue('npm')
    mockUpdatePackages.mockReset()
    mockCheckPackageVersions.mockReset()
    mockPackageManager.mockImplementation(
      () =>
        ({
          manager: {
            updatePackages: mockUpdatePackages,
            checkPackageVersions: mockCheckPackageVersions,
          },
        }) as unknown as InstanceType<typeof PackageManager>,
    )
    mockFilterPackages.mockReset().mockResolvedValue([])

    program = new Command()
    program.exitOverride()
    updateCommand(program)
  })

  it('registers the update command', () => {
    const cmd = program.commands.find((c) => c.name() === 'update')
    expect(cmd).toBeDefined()
  })

  it('calls updatePackages on action', async () => {
    mockUpdatePackages.mockResolvedValue([])
    await program.parseAsync(['node', 'test', 'update'])
    expect(mockUpdatePackages).toHaveBeenCalledWith(
      expect.any(String),
      undefined,
    )
  })

  it('passes target packages when specified', async () => {
    mockUpdatePackages.mockResolvedValue([])
    await program.parseAsync(['node', 'test', 'update', 'react', 'lodash'])
    expect(mockUpdatePackages).toHaveBeenCalledWith(expect.any(String), [
      'react',
      'lodash',
    ])
  })

  it('runs dry-run without calling updatePackages', async () => {
    mockCheckPackageVersions.mockResolvedValue({
      react: { name: 'react', current: '18.0.0', latest: '18.0.1' },
    })
    mockFilterPackages.mockResolvedValue([
      {
        name: 'react',
        current: '18.0.0',
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
        latest: '18.0.1',
        updateType: 'patch' as const,
        updated: true,
      },
    ]
    mockCheckPackageVersions.mockResolvedValue({
      react: { name: 'react', current: '18.0.0', latest: '18.0.1' },
    })
    mockFilterPackages.mockResolvedValue(results)

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

    expect(mockFilterPackages).not.toHaveBeenCalled()
    expect(mockUpdatePackages).not.toHaveBeenCalled()
  })
})
