jest.mock('@/utils/config', () => ({
  loadConfig: jest.fn(() => ({
    allowMinorUpdates: false,
    allowMajorUpdates: false,
    debug: false,
    silent: false,
    updateAllowlist: [],
    updateDenylist: [],
    cooldown: 0,
  })),
}))

import type { UpdateResult } from '@/types'
import logger, { pluralize } from '@/utils/logger'

const originalLog = Object.getPrototypeOf(console).log

describe('Logger', () => {
  let logSpy: jest.SpyInstance

  beforeEach(() => {
    console.log = originalLog
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    logger.setQuiet(false)
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  describe('basic message methods', () => {
    it('info logs message', () => {
      logger.info('test message')
      expect(logSpy.mock.calls[0][0]).toContain('test message')
    })

    it('success logs message', () => {
      logger.success('it worked')
      expect(logSpy.mock.calls[0][0]).toContain('it worked')
    })

    it('warn logs message', () => {
      logger.warn('be careful')
      expect(logSpy.mock.calls[0][0]).toContain('be careful')
    })

    it('error logs message', () => {
      logger.error('something failed')
      expect(logSpy.mock.calls[0][0]).toContain('something failed')
    })

    it('command stays silent when debug is off', () => {
      logger.command('npm outdated')
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('workspace logs manager name', () => {
      logger.workspace('PNPM')
      expect(logSpy.mock.calls[0][0]).toContain('PNPM')
    })

    it('allUpToDate logs success message', () => {
      logger.allUpToDate()
      expect(logSpy.mock.calls[0][0]).toContain('up to date')
    })

    it('outdatedHeader logs header without legend when allow/deny lists are empty', () => {
      logger.outdatedHeader()
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('Outdated packages found')
    })

    it('packageGroupHeader shows group name', () => {
      logger.packageGroupHeader('@babel')
      expect(logSpy.mock.calls[0][0]).toContain('@babel packages')
    })

    it('packageGroupHeader shows "Other packages" for unscoped', () => {
      logger.packageGroupHeader('unscoped')
      expect(logSpy.mock.calls[0][0]).toContain('Other packages')
    })

    it('updatingHeader includes the manager name', () => {
      logger.updatingHeader('npm')
      expect(logSpy.mock.calls[0][0]).toContain('npm')
    })

    it('starting logs operation and manager', () => {
      logger.starting('Checking packages', 'npm')
      expect(logSpy.mock.calls[0][0]).toContain('npm')
    })

    it('clean logs raw message', () => {
      logger.clean('raw output')
      expect(logSpy).toHaveBeenCalledWith('raw output')
    })

    it('debug stays silent when debug is off', () => {
      logger.debug('debug info')
      expect(logSpy).not.toHaveBeenCalled()
    })
  })

  describe('printOutdatedRows', () => {
    it('renders one line per row with name + versions', () => {
      logger.printOutdatedRows([
        { name: 'react', current: '18.0.0', latest: '19.0.0' },
        { name: 'semver', current: '7.5.0', latest: '7.7.4' },
      ])
      expect(logSpy).toHaveBeenCalledTimes(2)
      expect(logSpy.mock.calls[0][0]).toContain('react')
      expect(logSpy.mock.calls[0][0]).toContain('19.0.0')
      expect(logSpy.mock.calls[1][0]).toContain('semver')
    })

    it('appends release age when provided', () => {
      logger.printOutdatedRows([
        { name: 'react', current: '18.0.0', latest: '19.0.0', releaseAge: 12 },
      ])
      expect(logSpy.mock.calls[0][0]).toContain('released 12d ago')
    })

    it('does not mention release when omitted', () => {
      logger.printOutdatedRows([
        { name: 'react', current: '18.0.0', latest: '19.0.0' },
      ])
      expect(logSpy.mock.calls[0][0]).not.toContain('released')
    })

    it('is a no-op for an empty list', () => {
      logger.printOutdatedRows([])
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('left-pads name and current columns to align across rows', () => {
      logger.printOutdatedRows([
        { name: 'a', current: '1.0.0', latest: '2.0.0' },
        { name: 'looong', current: '11.22.33', latest: '11.22.34' },
      ])
      // biome-ignore lint/suspicious/noControlCharactersInRegex: Allow here to strip ANSI color codes for testing alignment
      const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*[A-Za-z]/g, '')
      expect(stripAnsi(logSpy.mock.calls[0][0])).toMatch(/a\s{6}\s+1\.0\.0\s+→/)
      expect(stripAnsi(logSpy.mock.calls[1][0])).toMatch(/looong\s+11\.22\.33/)
    })
  })

  describe('printSkippedRows', () => {
    it('uses default note when no reason is provided', () => {
      logger.printSkippedRows([
        {
          name: 'react',
          current: '18.0.0',
          latest: '19.0.0',
          updateType: 'major',
        },
      ])
      expect(logSpy.mock.calls[0][0]).toContain('major update skipped')
    })

    it('prefers explicit reason over default', () => {
      logger.printSkippedRows([
        {
          name: 'react',
          current: '18.0.0',
          latest: '19.0.0',
          updateType: 'major',
          reason: 'cooldown: released 3d ago, requires 30d',
        },
      ])
      const out = logSpy.mock.calls[0][0]
      expect(out).toContain('cooldown: released 3d ago')
      expect(out).not.toContain('major update skipped')
    })
  })

  describe('noPackagesToUpdate', () => {
    it('renders header + indented body lines', () => {
      logger.noPackagesToUpdate(['First sentence.', 'Second sentence.'])
      expect(logSpy).toHaveBeenCalledTimes(3)
      expect(logSpy.mock.calls[0][0]).toContain('No packages to update')
      expect(logSpy.mock.calls[1][0]).toContain('First sentence.')
      expect(logSpy.mock.calls[2][0]).toContain('Second sentence.')
    })

    it('accepts a single string as well', () => {
      logger.noPackagesToUpdate('Solo message.')
      expect(logSpy).toHaveBeenCalledTimes(2)
      expect(logSpy.mock.calls[1][0]).toContain('Solo message.')
    })
  })

  describe('cooldownSummary', () => {
    const makeResult = (overrides: Partial<UpdateResult>): UpdateResult => ({
      name: 'foo',
      current: '1.0.0',
      latest: '1.0.1',
      updateType: 'patch',
      updated: false,
      ...overrides,
    })

    it('is a no-op when nothing is gated by cooldown', () => {
      logger.cooldownSummary([
        makeResult({ updated: true }),
        makeResult({
          updated: false,
          reason: 'skipped by config',
        }),
      ])
      expect(logSpy).not.toHaveBeenCalled()
    })

    it('prints header and rows when cooldown gated packages exist', () => {
      logger.cooldownSummary([
        makeResult({
          name: 'react',
          current: '18.0.0',
          latest: '19.0.0',
          updateType: 'major',
          reason: 'cooldown: released 3d ago, requires 30d',
        }),
      ])
      expect(logSpy).toHaveBeenCalledTimes(2)
      expect(logSpy.mock.calls[0][0]).toContain('held by cooldown')
      expect(logSpy.mock.calls[1][0]).toContain('react')
      expect(logSpy.mock.calls[1][0]).toContain('cooldown: released 3d ago')
    })
  })

  describe('quiet mode', () => {
    it('suppresses all output when quiet is true', () => {
      logger.setQuiet(true)
      logger.info('x')
      logger.success('x')
      logger.warn('x')
      logger.error('x')
      logger.allUpToDate()
      logger.outdatedHeader()
      logger.packageGroupHeader('@x')
      logger.printOutdatedRows([
        { name: 'p', current: '1.0.0', latest: '1.0.1' },
      ])
      logger.printSkippedRows([
        {
          name: 'p',
          current: '1.0.0',
          latest: '1.0.1',
          updateType: 'major',
        },
      ])
      logger.noPackagesToUpdate('msg')
      logger.cooldownSummary([])
      logger.starting('op', 'npm')
      logger.clean('msg')
      logger.debug('dbg')
      expect(logSpy).not.toHaveBeenCalled()
    })
  })
})

describe('pluralize', () => {
  it('uses singular for 1', () => {
    expect(pluralize(1, 'package')).toBe('1 package')
  })

  it('appends s by default for non-1 counts', () => {
    expect(pluralize(2, 'package')).toBe('2 packages')
    expect(pluralize(0, 'package')).toBe('0 packages')
  })

  it('honors an explicit plural form', () => {
    expect(pluralize(2, 'index', 'indices')).toBe('2 indices')
  })
})
