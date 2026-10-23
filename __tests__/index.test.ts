import { ConfigError } from '@/utils/config'

// Loading the CLI loads the config file (the logger reads it on import), so
// a bad config surfaces while `./cli` is being imported.
jest.mock('@/cli', () => {
  const { ConfigError: ActualConfigError } =
    jest.requireActual('@/utils/config')
  throw new ActualConfigError(
    'Failed to load JSON config from /project/.always-up-to-date.json: rules["react"] must be one of "hold", "followRange", "latest" (got "hodl")',
  )
})

import { main } from '@/index'

const originalError = Object.getPrototypeOf(console).error

describe('CLI entry', () => {
  let stderr: string[]
  let exit: jest.SpyInstance

  beforeEach(() => {
    stderr = []
    console.error = originalError
    jest
      .spyOn(console, 'error')
      .mockImplementation((...parts) => stderr.push(parts.join(' ')))
    exit = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never)
  })

  it('prints a config error as one line and exits 1', async () => {
    await main()

    expect(exit).toHaveBeenCalledWith(1)
    expect(stderr).toEqual([
      'autd: Failed to load JSON config from /project/.always-up-to-date.json: rules["react"] must be one of "hold", "followRange", "latest" (got "hodl")',
    ])
  })

  it('exports ConfigError for the entry to recognise', () => {
    expect(new ConfigError('x')).toBeInstanceOf(Error)
  })
})
