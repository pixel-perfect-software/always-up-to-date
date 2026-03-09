import fs from 'fs'
import { DEFAULT_CONFIG, loadConfig, saveJsonConfig } from '@/utils/config'
import { checkIfFileExists } from '@/utils/files'

jest.mock('fs')
jest.mock('@/utils/files', () => ({
  checkIfFileExists: jest.fn(),
}))

const mockedFs = jest.mocked(fs)
const mockedCheckIfFileExists = jest.mocked(checkIfFileExists)

describe('loadConfig', () => {
  it('returns default config when no config file exists', () => {
    mockedCheckIfFileExists.mockReturnValue(false)
    const config = loadConfig('/test')
    expect(config).toEqual(DEFAULT_CONFIG)
  })

  it('loads and merges JSON config with defaults', () => {
    mockedCheckIfFileExists.mockReturnValue(true)
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ allowMinorUpdates: true }),
    )

    const config = loadConfig('/test')

    expect(config.allowMinorUpdates).toBe(true)
    expect(config.allowMajorUpdates).toBe(false) // default
    expect(config.updateAllowlist).toEqual([]) // default
  })

  it('coerces non-boolean values to booleans', () => {
    mockedCheckIfFileExists.mockReturnValue(true)
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ allowMinorUpdates: 'yes', debug: 1 }),
    )

    const config = loadConfig('/test')

    expect(config.allowMinorUpdates).toBe(true)
    expect(config.debug).toBe(true)
  })

  it('falls back to default for non-array allowlist/denylist', () => {
    mockedCheckIfFileExists.mockReturnValue(true)
    mockedFs.readFileSync.mockReturnValue(
      JSON.stringify({ updateAllowlist: 'not-an-array' }),
    )

    const config = loadConfig('/test')

    expect(config.updateAllowlist).toEqual([])
  })

  it('throws on malformed JSON', () => {
    mockedCheckIfFileExists.mockReturnValue(true)
    mockedFs.readFileSync.mockReturnValue('{ invalid json')

    expect(() => loadConfig('/test')).toThrow('Failed to load JSON config')
  })
})

describe('saveJsonConfig', () => {
  it('writes config as formatted JSON', () => {
    mockedFs.writeFileSync.mockImplementation(() => undefined)

    saveJsonConfig(DEFAULT_CONFIG, '/test/.always-up-to-date.json')

    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      '/test/.always-up-to-date.json',
      JSON.stringify(DEFAULT_CONFIG, null, 2),
      'utf8',
    )
  })
})
