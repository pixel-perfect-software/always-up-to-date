import { Command } from 'commander'

jest.mock('@/utils/logger')
jest.mock('@/utils/config')

const mockCheckIfFileExists = jest.fn()
jest.mock('@/utils/files', () => ({
  checkIfFileExists: mockCheckIfFileExists,
}))

import initCommand from '@/commands/init'
import { saveJsonConfig } from '@/utils/config'

const mockedSaveJsonConfig = jest.mocked(saveJsonConfig)

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

    const writtenConfig = mockedSaveJsonConfig.mock.calls[0][0] as unknown as {
      $schema?: string
      allowMinorUpdates: boolean
      cooldown: number
    }
    expect(writtenConfig.$schema).toMatch(/config\.schema\.json$/)
    expect(writtenConfig.allowMinorUpdates).toBe(false)
    expect(writtenConfig.cooldown).toBe(0)
  })

  it('does not create config when one already exists', async () => {
    mockCheckIfFileExists.mockReturnValue(true)
    await program.parseAsync(['node', 'test', 'init'])
    expect(mockedSaveJsonConfig).not.toHaveBeenCalled()
  })
})
