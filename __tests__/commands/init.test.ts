import { Command } from 'commander'

jest.mock('@/utils/logger')
jest.mock('@/utils/config')
jest.mock('@/utils/files')

import initCommand from '@/commands/init'
import { saveJsonConfig } from '@/utils/config'
import { checkIfFileExists } from '@/utils/files'

const mockedSaveJsonConfig = jest.mocked(saveJsonConfig)
const mockCheckIfFileExists = jest.mocked(checkIfFileExists)

describe('init command', () => {
  let program: Command

  beforeEach(() => {
    program = new Command()
    program.exitOverride()
    initCommand(program)
  })

  it('registers the init command', () => {
    const cmd = program.commands.find((c) => c.name() === 'init')
    expect(cmd).toBeDefined()
  })

  it('creates config file when none exists', async () => {
    mockCheckIfFileExists.mockReturnValue(false)
    await program.parseAsync(['node', 'test', 'init'])
    expect(mockedSaveJsonConfig).toHaveBeenCalled()
  })

  it('includes a $schema reference in the generated config', async () => {
    mockCheckIfFileExists.mockReturnValue(false)
    await program.parseAsync(['node', 'test', 'init'])

    const writtenConfig = mockedSaveJsonConfig.mock.calls[0][0]
    expect(writtenConfig.$schema).toMatch(/config\.schema\.json$/)
    expect(writtenConfig.cooldown).toBe(0)
  })

  it('writes the beyondRange and rules shape, without the legacy fields', async () => {
    mockCheckIfFileExists.mockReturnValue(false)
    await program.parseAsync(['node', 'test', 'init'])

    const writtenConfig = mockedSaveJsonConfig.mock.calls[0][0]
    expect(writtenConfig).toMatchObject({ beyondRange: 'none', rules: {} })
    for (const legacy of [
      'allowMinorUpdates',
      'allowMajorUpdates',
      'updateAllowlist',
      'updateDenylist',
    ]) {
      expect(writtenConfig).not.toHaveProperty(legacy)
    }
  })

  it('does not create config when one already exists', async () => {
    mockCheckIfFileExists.mockReturnValue(true)
    await program.parseAsync(['node', 'test', 'init'])
    expect(mockedSaveJsonConfig).not.toHaveBeenCalled()
  })
})
