import { Command } from 'commander'

jest.mock('@/detectPackageManager', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue('npm'),
}))

jest.mock('@/pipeline', () => ({ check: jest.fn() }))

jest.mock('@/utils/logger')
jest.mock('@/utils/config')

import checkCommand from '@/commands/check'
import detectPackageManager from '@/detectPackageManager'
import npm from '@/managers/npm'
import yarn from '@/managers/yarn'
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
      expect.objectContaining({ adapter: npm, cwd: expect.any(String) }),
    )
  })

  it('uses the manager --pm names', async () => {
    jest.mocked(detectPackageManager).mockReturnValueOnce('yarn')
    mockCheckPackageVersions.mockResolvedValue({})

    await program.parseAsync(['node', 'test', 'check', '--pm', 'yarn'])

    expect(detectPackageManager).toHaveBeenCalledWith(
      expect.any(String),
      'yarn',
    )
    expect(mockCheckPackageVersions).toHaveBeenCalledWith(
      expect.objectContaining({ adapter: yarn }),
    )
  })

  it('rejects a --pm autd does not support', async () => {
    // commander prints the error before throwing it; keep the test output clean.
    program.configureOutput({ writeErr: jest.fn() })

    await expect(
      program.parseAsync(['node', 'test', 'check', '--pm', 'deno']),
    ).rejects.toThrow(
      "option '--pm <manager>' argument 'deno' is invalid. Allowed choices are npm, yarn, pnpm, bun.",
    )
    expect(mockCheckPackageVersions).not.toHaveBeenCalled()
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
