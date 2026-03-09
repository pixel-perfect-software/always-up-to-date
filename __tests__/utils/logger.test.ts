jest.mock('@/utils/config', () => ({
  loadConfig: jest.fn(() => ({
    allowMinorUpdates: false,
    allowMajorUpdates: false,
    debug: false,
    silent: false,
    updateAllowlist: [],
    updateDenylist: [],
  })),
}))

import logger from '@/utils/logger'

// Re-enable console.log for this test file since setup.ts suppresses it
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

  describe('output methods', () => {
    it('info logs message', () => {
      logger.info('test message')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('test message')
    })

    it('success logs message', () => {
      logger.success('it worked')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('it worked')
    })

    it('warn logs message', () => {
      logger.warn('be careful')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('be careful')
    })

    it('error logs message', () => {
      logger.error('something failed')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('something failed')
    })

    it('command logs the command string', () => {
      logger.command('npm outdated')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('npm outdated')
    })

    it('workspace logs manager name', () => {
      logger.workspace('PNPM')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('PNPM')
    })

    it('allUpToDate logs success message', () => {
      logger.allUpToDate()
      expect(logSpy).toHaveBeenCalledTimes(1)
    })

    it('outdatedHeader logs header with legend', () => {
      logger.outdatedHeader()
      expect(logSpy).toHaveBeenCalledTimes(3)
    })

    it('outdatedPackage logs package with version arrow', () => {
      logger.outdatedPackage('react', '18.0.0', '19.0.0')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('react')
      expect(logSpy.mock.calls[0][0]).toContain('18.0.0')
      expect(logSpy.mock.calls[0][0]).toContain('19.0.0')
    })

    it('packageGroupHeader shows group name', () => {
      logger.packageGroupHeader('@babel')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('@babel packages')
    })

    it('packageGroupHeader shows "Other packages" for unscoped', () => {
      logger.packageGroupHeader('unscoped')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('Other packages')
    })

    it('outdatedPackageInGroup logs package info', () => {
      logger.outdatedPackageInGroup('lodash', '4.17.0', '4.18.0')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('lodash')
    })

    it('updatingHeader logs update message', () => {
      logger.updatingHeader()
      expect(logSpy).toHaveBeenCalledTimes(1)
    })

    it('updatingPackage logs package update', () => {
      logger.updatingPackage('react', '18.0.0', '19.0.0')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('react')
    })

    it('skippingPackage logs skip reason', () => {
      logger.skippingPackage('react', '18.0.0', '19.0.0', 'major')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('major')
      expect(logSpy.mock.calls[0][0]).toContain('skipped')
    })

    it('starting logs operation and manager', () => {
      logger.starting('Checking packages', 'NPM')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('NPM')
    })

    it('clean logs raw message', () => {
      logger.clean('raw output')
      expect(logSpy).toHaveBeenCalledWith('raw output')
    })

    it('debug logs message', () => {
      logger.debug('debug info')
      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('debug info')
    })
  })

  describe('quiet mode', () => {
    it('suppresses all output when quiet is true', () => {
      logger.setQuiet(true)

      logger.info('should not appear')
      logger.success('should not appear')
      logger.warn('should not appear')
      logger.error('should not appear')
      logger.command('should not appear')
      logger.workspace('NPM')
      logger.allUpToDate()
      logger.outdatedHeader()
      logger.outdatedPackage('pkg', '1.0.0', '2.0.0')
      logger.packageGroupHeader('@test')
      logger.outdatedPackageInGroup('pkg', '1.0.0', '2.0.0')
      logger.updatingHeader()
      logger.updatingPackage('pkg', '1.0.0', '2.0.0')
      logger.skippingPackage('pkg', '1.0.0', '2.0.0', 'major')
      logger.starting('op', 'mgr')
      logger.clean('msg')
      logger.debug('dbg')
      logger.packageOperation('msg')

      expect(logSpy).not.toHaveBeenCalled()
    })
  })
})
