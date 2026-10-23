import { Command } from 'commander'

jest.mock('@/detectPackageManager', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue('npm'),
}))

jest.mock('@/pipeline', () => ({ check: jest.fn() }))

jest.mock('@/utils/logger')
jest.mock('@/utils/config')
jest.mock('@/utils/registry', () => ({
  clearRegistryCache: jest.fn(),
  fetchReleaseTimes: jest.fn(),
}))

import checkCommand from '@/commands/check'
import npm from '@/managers/npm'
import { check } from '@/pipeline'

const mockCheckPackageVersions = jest.mocked(check)

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

  it("runs the check pipeline with the detected manager's adapter", async () => {
    mockCheckPackageVersions.mockResolvedValue({})
    await program.parseAsync(['node', 'test', 'check'])
    expect(mockCheckPackageVersions).toHaveBeenCalledWith(
      npm,
      expect.any(String),
    )
  })

  it('outputs JSON when --json flag is passed', async () => {
    const mockData = {
      react: {
        name: 'react',
        current: '18.0.0',
        wanted: '18.0.0',
        latest: '19.0.0',
      },
    }
    mockCheckPackageVersions.mockResolvedValue(mockData)

    const consoleSpy = jest.spyOn(console, 'log').mockImplementation()
    await program.parseAsync(['node', 'test', 'check', '--json'])

    expect(consoleSpy).toHaveBeenCalledWith(JSON.stringify(mockData, null, 2))
    consoleSpy.mockRestore()
  })
})
