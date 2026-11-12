import { stripVTControlCharacters } from 'util'
import type { UpdateResult } from '@/types'
import logger, { formatElapsed, pluralize } from '@/utils/logger'
import { groupResults, splitAtChange } from '@/utils/report'
import { reasonFor } from '../fixtures/reasons'

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
  reason: reasonFor('within range'),
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
  reason: reasonFor(reason),
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

    it('memberRun names the manager, the member and its place among the manifests', () => {
      logger.memberRun('npm', 'packages/a', 3)
      expect(stripVTControlCharacters(logSpy.mock.calls[0][0])).toContain(
        'npm workspace member packages/a (1 of 3 manifests)',
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
        '  motion       apps/web          14.6.0 → 14.7.1       released 3d ago',
        '\nHeld by cooldown (1 package)',
        '  vercel       (root)            65.2.0 → 65.4.0       released 14h ago, needs 2d',
        '\nPast the range in package.json (1 package) · "beyondRange": "major" would move it',
        '  @types/node  (root), apps/web  25.9.9 → 26.6.5       major',
        '\nHeld by a rule (1 package)',
        '  prisma       apps/web          7.10.1 → 8.0.0-rc.27  rule "hold"',
        '\n1 to update · 1 held by cooldown · 1 past the range · 1 held by a rule',
      ])
    })

    it('shows the version a cooldown hold judged, with its age, not latest (#221)', () => {
      // react ^18.2.0 at 18.2.0: the cooldown judged 18.3.1 (a minor step),
      // while latest is 19.3.1 (a major one).
      logger.report(
        [
          held('react', 'cooldown: released 929d ago, requires 3000d', {
            current: '18.2.0',
            wanted: '18.3.1',
            latest: '19.3.1',
            judged: '18.3.1',
            updateType: 'minor',
          }),
        ],
        'npm',
        'plan',
      )

      expect(printed()).toEqual([
        '\nHeld by cooldown (1 package)',
        '  react  18.2.0 → 18.3.1  released 929d ago, needs 3000d',
        '\nNothing to update: 1 held by cooldown',
      ])
    })

    it('shows a peer hold and a not-applied row at the version they judged (#221)', () => {
      const [peer, notApplied] = [
        held('react-dom', 'peer conflict: react@18.2.0 needs react-dom ^18', {
          current: '18.2.0',
          wanted: '18.3.1',
          latest: '19.3.1',
          judged: '19.3.1',
          updateType: 'major',
        }),
        held('zod', 'not applied by npm (installed 3.21.4)', {
          current: '3.21.4',
          wanted: '3.25.76',
          latest: '4.6.7',
          judged: '3.25.76',
          updateType: 'major',
        }),
      ]
      expect(groupResults([peer])[0].rows).toMatchObject([
        { to: '19.3.1', level: 'major' },
      ])
      expect(groupResults([notApplied], 'applied')[0].rows).toMatchObject([
        { to: '3.25.76', level: 'minor' },
      ])
    })

    it('keeps latest for a row held by its range (#221)', () => {
      const [section] = groupResults(
        [held('ms', 'major beyond the range', { latest: '3.0.0' })],
        'plan',
      )
      expect(section.rows).toMatchObject([{ to: '3.0.0', level: 'major' }])
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
        '  ms     1.0.0 → 1.0.1',
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
      expect(printed()[1]).toBe('  a  1.0.0 → 1.0.1')
    })

    it('leaves the manifest column out of a member run (#123)', () => {
      logger.report([moved('a', { workspace: 'packages/a' })], 'npm', 'plan', {
        member: 'packages/a',
      })
      expect(printed()[1]).toBe('  a  1.0.0 → 1.0.1')
    })

    it('names the version a cooldown fallback skipped, within its range (#147)', () => {
      logger.report(
        [
          moved('a', {
            wanted: '1.0.3',
            latest: '1.0.3',
            target: '1.0.2',
            reason: reasonFor(
              'cooldown: 1.0.3 released 1d ago, requires 2d',
              'cooldown-fallback',
            ),
          }),
        ],
        'npm',
        'plan',
      )
      expect(printed()[1]).toBe(
        '  a  1.0.0 → 1.0.2  1.0.3 held by cooldown (released 1d ago, needs 2d)',
      )
    })

    it('names the version npm skipped for the Node, and keeps the row under update (#200)', () => {
      logger.report(
        [
          moved('typescript', {
            current: '5.0.2',
            wanted: '5.1.6',
            latest: '5.1.6',
            target: '5.0.4',
            reason: reasonFor(
              'engines: 5.1.6 needs node >=14.17 (running node 12.22.12)',
              'engines-fallback',
            ),
          }),
        ],
        'npm',
        'plan',
      )
      const lines = printed()
      expect(lines).toContain(
        '  typescript  5.0.2 → 5.0.4  5.1.6 needs node >=14.17 (running node 12.22.12)',
      )
      expect(lines.join('\n')).not.toContain('Held by engines.node')
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
            warnings: [
              reasonFor('peer conflict: react-dom@18.3.1 needs react ^18.3.1'),
            ],
          }),
        ],
        'npm',
        'plan',
      )
      expect(printed()[1]).toContain(
        'rewrites its range · peer conflict: react-dom@18.3.1 needs react ^18.3.1',
      )
    })

    it('names the beyondRange level once per section, with how many each level moves', () => {
      logger.report(
        [
          held('express', 'minor beyond the range', { latest: '1.1.0' }),
          held('typescript', 'major beyond the range'),
          held('zod', 'major beyond the range'),
        ].map((row) => ({
          ...row,
          reason: { ...row.reason, code: 'outside-range' },
        })),
        'npm',
        'plan',
      )
      expect(printed().slice(0, 4)).toEqual([
        '\nPast the range in package.json (3 packages) · "beyondRange": "minor" would move 1, "major" all 3',
        '  express     1.0.0 → 1.1.0  minor',
        '  typescript  1.0.0 → 2.0.0  major',
        '  zod         1.0.0 → 2.0.0  major',
      ])
    })

    it('ends a plan with the command that applies it, from the root for a member', () => {
      logger.report([moved('ms')], 'npm', 'plan', { next: 'autd update ms' })
      expect(printed().at(-1)).toBe('Run autd update ms to apply.')

      logSpy.mockClear()
      logger.report([moved('ms')], 'npm', 'plan', {
        member: 'packages/a',
        next: 'autd update',
      })
      expect(printed().at(-1)).toBe(
        'Run autd update in the workspace root to apply.',
      )

      logSpy.mockClear()
      logger.report([held('a', 'held by rule')], 'npm', 'plan', {
        next: 'autd update',
      })
      expect(printed().at(-1)).toBe('\nNothing to update: 1 held by a rule')
    })

    it('says how long an applied update took on its summary line', () => {
      logger.report([moved('ms')], 'npm', 'applied', { elapsedMs: 12_345 })
      expect(printed().at(-1)).toBe('\n1 updated  (took 12.3s)')
    })

    it('says a move past the range rewrote it once applied, not that it is past it', () => {
      logger.report(
        [
          moved('commander', {
            current: '15.0.0',
            wanted: '15.0.0',
            target: '15.1.0',
            latest: '15.1.0',
          }),
          moved('ms'),
        ],
        'npm',
        'applied',
      )
      expect(printed()).toEqual([
        '\nUpdated (2 packages)',
        '  commander  15.0.0 → 15.1.0  range rewritten',
        '  ms         1.0.0  → 1.0.1',
        '\n2 updated',
      ])
    })

    it('shows a deprecated target with the registry message (#195)', () => {
      logger.report(
        [
          held('lodash', 'deprecated: Bad release. Please use 4.17.21.', {
            current: '4.17.21',
            latest: '4.18.0',
          }),
        ],
        'npm',
        'plan',
      )
      expect(printed()[1]).toBe(
        '  lodash  4.17.21 → 4.18.0  Bad release. Please use 4.17.21.',
      )
    })

    it('shows a license change with both licenses, after deprecated holds (#197)', () => {
      logger.report(
        [
          held('ua-parser-js', 'license change: MIT → AGPL-3.0-or-later', {
            current: '1.0.39',
            latest: '2.0.0',
          }),
          held('lodash', 'deprecated: Bad release.', {
            current: '4.17.21',
            latest: '4.18.0',
          }),
        ],
        'npm',
        'plan',
      )
      const lines = printed()
      expect(lines).toContain('\nHeld as deprecated (1 package)')
      expect(lines).toContain('\nHeld for a license change (1 package)')
      expect(lines.indexOf('\nHeld as deprecated (1 package)')).toBeLessThan(
        lines.indexOf('\nHeld for a license change (1 package)'),
      )
      expect(lines).toContain(
        '  ua-parser-js  1.0.39  → 2.0.0   MIT → AGPL-3.0-or-later',
      )
      expect(lines.at(-1)).toContain('1 held for a license change')
    })

    it('shows an engines hold after a license change, with both ranges (#199)', () => {
      logger.report(
        [
          held(
            'commander',
            'engines: needs node >=20 (the project declares >=18)',
            {
              current: '13.1.0',
              latest: '14.0.0',
            },
          ),
          held('ua-parser-js', 'license change: MIT → ISC', {
            current: '1.0.39',
            latest: '2.0.0',
          }),
        ],
        'npm',
        'plan',
      )
      const lines = printed()
      expect(lines).toContain('\nHeld by engines.node (1 package)')
      expect(
        lines.indexOf('\nHeld for a license change (1 package)'),
      ).toBeLessThan(lines.indexOf('\nHeld by engines.node (1 package)'))
      expect(lines).toContain(
        '  commander     13.1.0 → 14.0.0  needs node >=20 (the project declares >=18)',
      )
      expect(lines.at(-1)).toContain('held by engines.node')
    })

    it.each([
      [
        'engines: needs node >=20 (running node 18.0.0)',
        'Held by engines.node',
      ],
      ['license change: MIT → ISC', 'Held for a license change'],
      ['controlled by overrides (^1.0.0)', 'Held by an override'],
      [
        'peer conflict: react-dom@18.3.1 needs react ^18.3.1',
        'Held by a peer conflict',
      ],
      ['deprecated: Bad release.', 'Held as deprecated'],
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

describe('splitAtChange', () => {
  it.each([
    ['1.4.0', '1.20.0', ['1.', '20.0']],
    ['4.3.1', '4.3.7', ['4.3.', '7']],
    ['15.0.0', '16.0.0', ['', '16.0.0']],
    ['8.0.0-rc.26', '8.0.0-rc.27', ['8.0.0-rc.', '27']],
    ['missing', '2.0.0', ['', '2.0.0']],
  ])('%s → %s colors only what changes', (current, to, expected) => {
    expect(splitAtChange(current, to)).toEqual(expected)
  })
})

describe('formatElapsed', () => {
  it.each([
    [850, '850ms'],
    [12_345, '12.3s'],
    [125_000, '2m 05s'],
  ])('%d ms is %s', (ms, expected) => {
    expect(formatElapsed(ms)).toBe(expected)
  })
})
