import fs from 'fs'
import {
  ConfigError,
  configFileFor,
  DEFAULT_CONFIG,
  loadConfig,
  saveJsonConfig,
} from '@/utils/config'
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

  describe('beyondRange and rules', () => {
    const load = (json: Record<string, unknown>) => {
      mockedCheckIfFileExists.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(JSON.stringify(json))
      return loadConfig('/test')
    }

    it('reads beyondRange and rules', () => {
      const config = load({
        beyondRange: 'minor',
        rules: { react: 'hold', '@types/*': 'latest', zod: 'followRange' },
      })

      expect(config.beyondRange).toBe('minor')
      expect(config.rules).toEqual({
        react: 'hold',
        '@types/*': 'latest',
        zod: 'followRange',
      })
    })

    it('leaves beyondRange unset and rules empty when missing', () => {
      const config = load({ allowMinorUpdates: true })

      expect(config.beyondRange).toBeUndefined()
      expect(config.rules).toEqual({})
    })

    it('rejects an unknown beyondRange instead of silently ignoring it', () => {
      expect(() => load({ beyondRange: 'majr' })).toThrow(
        'beyondRange must be one of "none", "patch", "minor", "major" (got "majr")',
      )
    })

    it('rejects an unknown rule instead of updating a package meant to be held', () => {
      expect(() => load({ rules: { react: 'hodl' } })).toThrow(
        'rules["react"] must be one of "hold", "followRange", "latest" (got "hodl")',
      )
    })

    it('rejects rules that are not an object', () => {
      expect(() => load({ rules: ['react'] })).toThrow(
        'rules must be an object of package name to rule',
      )
    })
  })

  describe('cooldown', () => {
    it('defaults to 0 when missing', () => {
      mockedCheckIfFileExists.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({}))
      expect(loadConfig('/test').cooldown).toBe(0)
    })

    it('accepts a number', () => {
      mockedCheckIfFileExists.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ cooldown: 7 }))
      expect(loadConfig('/test').cooldown).toBe(7)
    })

    it('accepts a duration string', () => {
      mockedCheckIfFileExists.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({ cooldown: '1 week' }),
      )
      expect(loadConfig('/test').cooldown).toBe('1 week')
    })

    it('accepts a per-type object with mixed numbers and strings', () => {
      mockedCheckIfFileExists.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          cooldown: { patch: 0, minor: '1 week', major: 30 },
        }),
      )
      expect(loadConfig('/test').cooldown).toEqual({
        patch: 0,
        minor: '1 week',
        major: 30,
      })
    })

    it('drops invalid entries from the per-type object', () => {
      mockedCheckIfFileExists.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(
        JSON.stringify({
          cooldown: { patch: -3, minor: '1 week', major: null },
        }),
      )
      expect(loadConfig('/test').cooldown).toEqual({ minor: '1 week' })
    })

    it('falls back to default for invalid scalar values', () => {
      mockedCheckIfFileExists.mockReturnValue(true)
      mockedFs.readFileSync.mockReturnValue(JSON.stringify({ cooldown: -5 }))
      expect(loadConfig('/test').cooldown).toBe(0)
    })
  })
})

describe('depsDev', () => {
  beforeEach(() => mockedCheckIfFileExists.mockReturnValue(true))

  it('defaults to true', () => {
    mockedFs.readFileSync.mockReturnValue('{}')
    expect(loadConfig('/test').depsDev).toBe(true)
    expect(DEFAULT_CONFIG.depsDev).toBe(true)
  })

  it('reads false', () => {
    mockedFs.readFileSync.mockReturnValue(JSON.stringify({ depsDev: false }))
    expect(loadConfig('/test').depsDev).toBe(false)
  })

  it.each([['"false"'], ['0'], ['null'], ['"no"']])(
    'rejects %s instead of reading it as true',
    (value) => {
      mockedFs.readFileSync.mockReturnValue(`{ "depsDev": ${value} }`)
      expect(() => loadConfig('/test')).toThrow(
        `depsDev must be true or false (got ${value})`,
      )
    },
  )
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

describe('a member run: the working directory, else the fallback', () => {
  const own = '/root/packages/a/.always-up-to-date.json'
  const fallback = '/root/.always-up-to-date.json'
  const existing = (...files: string[]) =>
    mockedCheckIfFileExists.mockImplementation((file) => files.includes(file))
  const files = (contents: Record<string, object | string>) =>
    mockedFs.readFileSync.mockImplementation(((file: string) => {
      const content = contents[file]
      return typeof content === 'string' ? content : JSON.stringify(content)
    }) as unknown as typeof fs.readFileSync)

  it("uses the member's own file over the root's, with no per-key merge", () => {
    existing(own, fallback)
    files({
      [own]: { debug: true },
      [fallback]: { silent: true, debug: false },
    })

    const config = loadConfig('/root/packages/a', '/root')

    expect(config.debug).toBe(true)
    expect(config.silent).toBe(false)
    expect(configFileFor('/root/packages/a', '/root')).toBe(own)
  })

  it("uses the root's file when the member has none", () => {
    existing(fallback)
    files({ [fallback]: { silent: true } })

    expect(loadConfig('/root/packages/a', '/root').silent).toBe(true)
    expect(configFileFor('/root/packages/a', '/root')).toBe(fallback)
  })

  it('uses the defaults when neither has a file', () => {
    existing()

    expect(loadConfig('/root/packages/a', '/root')).toEqual(DEFAULT_CONFIG)
    expect(configFileFor('/root/packages/a', '/root')).toBeUndefined()
  })

  it("fails on a malformed member file rather than falling back to the root's", () => {
    existing(own, fallback)
    files({ [own]: '{ not json', [fallback]: { silent: true } })

    expect(() => loadConfig('/root/packages/a', '/root')).toThrow(ConfigError)
  })
})
