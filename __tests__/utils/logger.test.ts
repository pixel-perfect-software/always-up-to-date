import { stripVTControlCharacters } from 'util'
import type { UpdateResult } from '@/types'
import logger, { pluralize } from '@/utils/logger'

const originalLog = Object.getPrototypeOf(console).log

/** A row the plan moves, within its range unless `target` differs from `wanted`. */
const moved = (
  name: string,
  fields: Partial<UpdateResult> = {},
): UpdateResult => ({
  name,
  current: '1.0.0',
  wanted: '1.0.1',
  latest: '1.0.1',
  target: '1.0.1',
  updateType: 'patch',
  updated: true,
  ...fields,
})

/** A row the plan holds, with the reason the policy gave. */
const held = (
  name: string,
  reason: string,
  fields: Partial<UpdateResult> = {},
): UpdateResult => ({
  name,
  current: '1.0.0',
  wanted: '1.0.0',
  latest: '2.0.0',
  updateType: 'major',
  updated: false,
  reason,
  ...fields,
})

describe('Logger', () => {
  let logSpy: jest.SpyInstance

  beforeEach(() => {
    console.log = originalLog
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined)
    logger.configure({})
    logger.setQuiet(false)
  })

  afterEach(() => {
    logSpy.mockRestore()
  })

  describe('JSON output mode', () => {
    let errorSpy: jest.SpyInstance

    beforeEach(() => {
      console.error = Object.getPrototypeOf(console).error
      errorSpy = jest
        .spyOn(console, 'error')
        .mockImplementation(() => undefined)
      logger.setJsonOutput(true)
    })

    afterEach(() => {
      logger.setJsonOutput(false)
      errorSpy.mockRestore()
    })

    it('keeps progress output off stdout', () => {
      logger.starting('Checking dependencies', 'npm')
      logger.info('hello')
      logger.report([moved('a')], 'npm', 'plan')
      logger.allUpToDate()

      expect(logSpy).not.toHaveBeenCalled()
      expect(errorSpy).not.toHaveBeenCalled()
    })

    it('sends errors and warnings to stderr', () => {
      logger.warn('careful')
      logger.error('broke')

      expect(logSpy).not.toHaveBeenCalled()
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('careful'))
      expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('broke'))
    })

    it('stays silent when quiet', () => {
      logger.setQuiet(true)
      logger.error('broke')

      expect(errorSpy).not.toHaveBeenCalled()
    })
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

    it('workspace names the manager, the manifests and the catalogs', () => {
      logger.workspace('pnpm', 10, 20)
      expect(stripVTControlCharacters(logSpy.mock.calls[0][0])).toContain(
        'pnpm workspace: 10 manifests, 20 catalogs',
      )
    })

    it('allUpToDate logs success message', () => {
      logger.allUpToDate()
      expect(logSpy.mock.calls[0][0]).toContain('up to date')
    })

    it('updatingHeader names the package count and the manager', () => {
      logger.updatingHeader('npm', 4)
      expect(stripVTControlCharacters(logSpy.mock.calls[0][0])).toContain(
        'Updating 4 packages with npm',
      )
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

  describe('configure', () => {
    it('prints command and debug lines once debug is on', () => {
      logger.configure({ debug: true })

      logger.command('npm outdated')
      logger.debug('debug info')

      expect(logSpy.mock.calls[0][0]).toContain('npm outdated')
      expect(logSpy.mock.calls[1][0]).toContain('debug info')
    })

    it('mutes output when silent', () => {
      logger.configure({ silent: true })

      logger.info('hello')
      logger.allUpToDate()

      expect(logSpy).not.toHaveBeenCalled()
    })

    it('goes back to the defaults when configured with nothing', () => {
      logger.configure({ debug: true, silent: true })
      logger.configure({})

      logger.info('hello')
      logger.debug('debug info')

      expect(logSpy).toHaveBeenCalledTimes(1)
      expect(logSpy.mock.calls[0][0]).toContain('hello')
    })
  })

  describe('report', () => {
    const printed = () =>
      logSpy.mock.calls.map(([line]) => stripVTControlCharacters(line))

    it('prints every candidate once, under its outcome, then one summary line (#138)', () => {
      // The shape of the 2026-10-27 run in #138: a 2-day cooldown,
      // beyondRange "minor", rules hold prisma and zod.
      logger.report(
        [
          held('@types/node', 'major beyond the range', {
            workspace: '.',
            current: '25.9.9',
            latest: '26.6.5',
          }),
          held('@types/node', 'major beyond the range', {
            workspace: 'apps/web',
            current: '25.9.9',
            latest: '26.6.5',
          }),
          held('prisma', 'held by rule', {
            workspace: 'apps/web',
            current: '7.10.1',
            latest: '8.0.0-rc.27',
          }),
          held('vercel', 'cooldown: released 14h ago, requires 2d', {
            workspace: '.',
            current: '65.2.0',
            latest: '65.4.0',
            updateType: 'minor',
          }),
          moved('motion', {
            workspace: 'apps/web',
            current: '14.6.0',
            wanted: '14.7.1',
            target: '14.7.1',
            latest: '14.7.1',
            releaseAge: 3,
          }),
        ],
        'pnpm',
        'plan',
      )

      expect(printed()).toEqual([
        '\nWould update (1 package)',
        '  motion       apps/web          14.6.0 → 14.7.1       within range · released 3d ago',
        '\nHeld by cooldown (1 package)',
        '  vercel       (root)            65.2.0 → 65.4.0       released 14h ago, needs 2d',
        '\nPast the range in package.json (1 package)',
        '  @types/node  (root), apps/web  25.9.9 → 26.6.5       major; "beyondRange": "major" would move it',
        '\nHeld by a rule (1 package)',
        '  prisma       apps/web          7.10.1 → 8.0.0-rc.27  rule "hold"',
        '\n1 to update · 1 held by cooldown · 1 past the range · 1 held by a rule',
      ])
    })

    it('names what the manager left in place after apply, and what moved', () => {
      logger.report(
        [
          moved('ms'),
          held('debug', 'not applied by pnpm (installed 4.3.1)', {
            current: '4.3.1',
            latest: '4.4.3',
            target: '4.4.3',
          }),
        ],
        'pnpm',
        'applied',
      )

      expect(printed()).toEqual([
        '\nUpdated (1 package)',
        '  ms     1.0.0 → 1.0.1  within range',
        '\nLeft in place by pnpm (1 package)',
        '  debug  4.3.1 → 4.4.3  installed 4.3.1',
        '\n1 updated · 1 left in place by pnpm',
      ])
    })

    it('says when nothing moves, and leaves untargeted rows out', () => {
      logger.report(
        [held('a', 'held by rule'), held('b', 'not targeted')],
        'npm',
        'plan',
      )

      expect(printed()).toEqual([
        '\nHeld by a rule (1 package)',
        '  a  1.0.0 → 2.0.0  rule "hold"',
        '\nNothing to update: 1 held by a rule',
      ])
    })

    it('leaves the manifest column out when every row is the root', () => {
      logger.report([moved('a', { workspace: '.' })], 'pnpm', 'plan')
      expect(printed()[1]).toBe('  a  1.0.0 → 1.0.1  within range')
    })

    it('names the version a cooldown fallback skipped, within its range (#147)', () => {
      logger.report(
        [
          moved('a', {
            wanted: '1.0.3',
            latest: '1.0.3',
            target: '1.0.2',
            reason: 'cooldown: 1.0.3 released 1d ago, requires 2d',
          }),
        ],
        'npm',
        'plan',
      )
      expect(printed()[1]).toBe(
        '  a  1.0.0 → 1.0.2  within range; 1.0.3 released 1d ago, needs 2d',
      )
    })

    it('counts three or more manifests instead of listing them', () => {
      logger.report(
        ['.', 'a', 'b'].map((workspace) =>
          held('x', 'held by rule', { workspace }),
        ),
        'pnpm',
        'plan',
      )
      expect(printed()[1]).toContain('3 manifests')
    })

    it('marks a move past the range and keeps the peer warning', () => {
      logger.report(
        [
          moved('react', {
            wanted: '1.0.0',
            target: '2.0.0',
            latest: '2.0.0',
            warning: 'peer conflict: react-dom@18.3.1 needs react ^18.3.1',
          }),
        ],
        'npm',
        'plan',
      )
      expect(printed()[1]).toContain(
        'past its range; peer conflict: react-dom@18.3.1 needs react ^18.3.1',
      )
    })

    it.each([
      ['controlled by overrides (^1.0.0)', 'Held by an override'],
      [
        'peer conflict: react-dom@18.3.1 needs react ^18.3.1',
        'Held by a peer conflict',
      ],
      ['held with packages/a (held by rule)', 'Held with another manifest'],
      ['outside the range (rule followRange)', 'Held by a rule'],
      ['invalid version (current x, latest y)', 'Not updated'],
    ])('files %s under "%s"', (reason, heading) => {
      logger.report([held('p', reason)], 'npm', 'plan')
      expect(printed()[0]).toBe(`\n${heading} (1 package)`)
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
      logger.report([moved('p'), held('q', 'held by rule')], 'npm', 'plan')
      logger.updatingHeader('npm', 1)
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
