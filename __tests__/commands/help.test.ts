import { Command } from 'commander'

jest.mock('@/utils/logger')

import helpCommand from '@/commands/help'
import logger from '@/utils/logger'

const mockedLogger = jest.mocked(logger)

describe('help command', () => {
  let program: Command

  beforeEach(() => {
    program = new Command()
    program.exitOverride()
    helpCommand(program)
  })

  it('registers the help command', () => {
    const cmd = program.commands.find((c) => c.name() === 'help')
    expect(cmd).toBeDefined()
  })

  it('prints available commands', async () => {
    await program.parseAsync(['node', 'test', 'help'])
    expect(mockedLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Available commands'),
    )
    expect(mockedLogger.clean).toHaveBeenCalledTimes(5)
  })
})
