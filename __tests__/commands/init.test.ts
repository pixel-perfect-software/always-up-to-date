import { Command } from 'commander'
import fs from 'fs'
import path from 'path'

jest.mock('@/utils/logger')
jest.mock('@/utils/config')
jest.mock('@/utils/files')

import initCommand from '@/commands/init'
import { saveJsonConfig } from '@/utils/config'
import { checkIfFileExists } from '@/utils/files'
import logger from '@/utils/logger'
import { tempDir } from '../fixtures/files'

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

  it('writes the config when only a legacy .always-up-to-date file exists', async () => {
    // loadConfig never reads the legacy file, so it must not stop init.
    mockCheckIfFileExists.mockImplementation((file) =>
      file.endsWith(`${path.sep}.always-up-to-date`),
    )
    await program.parseAsync(['node', 'test', 'init'])
    expect(mockedSaveJsonConfig).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringMatching(/\.always-up-to-date\.json$/),
    )
  })

  it("writes where config is read: the nearest package.json's directory", async () => {
    const tmp = tempDir('autd-init-', { real: true })
    fs.mkdirSync(path.join(tmp, 'packages', 'a', 'src'), { recursive: true })
    fs.writeFileSync(path.join(tmp, 'packages', 'a', 'package.json'), '{}')
    jest
      .spyOn(process, 'cwd')
      .mockReturnValue(path.join(tmp, 'packages', 'a', 'src'))
    mockCheckIfFileExists.mockReturnValue(false)

    await program.parseAsync(['node', 'test', 'init'])

    const file = path.join(tmp, 'packages', 'a', '.always-up-to-date.json')
    expect(mockedSaveJsonConfig).toHaveBeenCalledWith(expect.anything(), file)
    expect(logger.success).toHaveBeenCalledWith(expect.stringContaining(file))
  })
})
