import { Command } from 'commander'

const mockCheckPackageVersions = jest.fn()

jest.mock('@/detectPackageManager', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue('npm'),
}))

jest.mock('@/managers', () => ({
  PackageManager: jest.fn().mockImplementation(() => ({
    manager: {
      checkPackageVersions: mockCheckPackageVersions,
    },
  })),
}))

jest.mock('@/utils/logger')

import checkCommand from '@/commands/check'

describe('check command', () => {
  let program: Command

  beforeEach(() => {
    program = new Command()
    program.exitOverride()
    checkCommand(program)
    mockCheckPackageVersions.mockReset()
  })

  it('registers the check command', () => {
    const cmd = program.commands.find((c) => c.name() === 'check')
    expect(cmd).toBeDefined()
  })

  it('calls checkPackageVersions on action', async () => {
    mockCheckPackageVersions.mockResolvedValue({})
    await program.parseAsync(['node', 'test', 'check'])
    expect(mockCheckPackageVersions).toHaveBeenCalled()
  })

  it('outputs JSON when --json flag is passed', async () => {
    const mockData = {
      react: { name: 'react', current: '18.0.0', latest: '19.0.0' },
    }
    mockCheckPackageVersions.mockResolvedValue(mockData)

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation()
    await program.parseAsync(['node', 'test', 'check', '--json'])

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(mockData, null, 2))
    consoleSpy.mockRestore()
  })
})
