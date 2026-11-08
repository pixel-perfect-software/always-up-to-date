import {
  formatDifference,
  formatMemory,
  formatSeconds,
  formatTiming,
  fullPackumentReads,
  hyperfineMajor,
  medianDifference,
  movingRows,
  parseBenchDocument,
  parseHyperfine,
  renderTable,
  throttledLines,
} from '../../bench/report'
import type { UpdateResult } from '../../src/types'
import { errorDocument, planDocument } from '../../src/utils/jsonDocument'
import { throttledNotice } from '../../src/utils/registryRequest'
import { readFixture } from '../fixtures'

describe('parseHyperfine', () => {
  it('reads the wall-clock and peak-memory summary of a real hyperfine 2 export', () => {
    const [timing] = parseHyperfine(readFixture('hyperfine/export.json'))

    expect(timing.runs).toBe(3)
    expect(timing.mean).toBeCloseTo(0.1053, 4)
    expect(timing.median).toBeCloseTo(0.0949, 4)
    expect(timing.stddev).toBeCloseTo(0.0209, 4)
    expect(timing.peakMemory).toBe(46137344)
  })

  it('leaves the peak memory out when the summary has none', () => {
    const results = JSON.parse(readFixture('hyperfine/export.json'))
    delete results.results[0].summary.memory_peak_resident

    expect(
      parseHyperfine(JSON.stringify(results))[0].peakMemory,
    ).toBeUndefined()
  })

  it('returns one timing per command, in order', () => {
    const results = JSON.parse(readFixture('hyperfine/export.json'))
    const second = structuredClone(results.results[0])
    second.summary.time_wall_clock.mean = 2
    results.results.push(second)

    expect(parseHyperfine(JSON.stringify(results)).map((t) => t.mean)).toEqual([
      expect.closeTo(0.1053, 4),
      2,
    ])
  })

  it('reads a single run, which has no deviation (`stddev: null`)', () => {
    const [timing] = parseHyperfine(
      readFixture('hyperfine/export-one-run.json'),
    )

    expect(timing.runs).toBe(1)
    expect(timing.stddev).toBe(0)
    expect(timing.mean).toBeGreaterThan(0)
    expect(formatTiming(timing)).toMatch(/ ± 0$/)
  })

  it('rejects hyperfine 1 output, which kept `mean` on the result', () => {
    const v1 = JSON.stringify({
      results: [{ command: 'node -e 0', mean: 0.04, stddev: 0.001 }],
    })

    expect(() => parseHyperfine(v1)).toThrow(/schema version 2 or later/)
  })

  it('rejects output that is not JSON, has no results, or has no wall-clock summary', () => {
    expect(() => parseHyperfine('not json')).toThrow(/no JSON/)
    expect(() =>
      parseHyperfine(JSON.stringify({ schema_version: 2, results: [] })),
    ).toThrow(/no results/)
    expect(() =>
      parseHyperfine(
        JSON.stringify({ schema_version: 2, results: [{ summary: {} }] }),
      ),
    ).toThrow(/result 0 has no wall-clock summary/)
  })
})

describe('hyperfineMajor', () => {
  it('reads the major version of `hyperfine --version`', () => {
    expect(hyperfineMajor('hyperfine 2.0.0\n')).toBe(2)
    expect(hyperfineMajor('hyperfine 1.19.0')).toBe(1)
    expect(hyperfineMajor('hyperfine')).toBeUndefined()
  })
})

describe('formatting', () => {
  it.each([
    [0.0126, '13 ms'],
    [0.126, '0.13 s'],
    [0.92, '0.92 s'],
    [14.83, '14.8 s'],
  ])('formats %s seconds as %s', (seconds, text) => {
    expect(formatSeconds(seconds)).toBe(text)
  })

  it.each([
    [0.123, '+0.12 s'],
    [0.0126, '+13 ms'],
    [-0.008, '-8 ms'],
    [-0.35, '-0.35 s'],
    [0, '+0 ms'],
    [-0.0004, '+0 ms'],
  ])('formats a difference of %s seconds as %s', (seconds, text) => {
    expect(formatDifference(seconds)).toBe(text)
  })

  it('formats a timing with its deviation in the mean’s unit', () => {
    expect(
      formatTiming({ mean: 0.92, stddev: 0.034, median: 0.9, runs: 5 }),
    ).toBe('0.92 s ± 0.03')
    expect(
      formatTiming({ mean: 0.041, stddev: 0.0036, median: 0.04, runs: 30 }),
    ).toBe('41 ms ± 4')
  })

  it('formats memory in megabytes, or n/a', () => {
    expect(formatMemory(347_400_000)).toBe('347 MB')
    expect(formatMemory(undefined)).toBe('n/a')
  })
})

describe('movingRows', () => {
  const result = (fields: Partial<UpdateResult>): UpdateResult => ({
    name: 'ms',
    current: '2.0.0',
    wanted: '2.0.0',
    latest: '2.1.3',
    updateType: 'minor',
    updated: false,
    reason: { code: 'outside-range', message: 'minor beyond the range' },
    ...fields,
  })
  const document = (results: UpdateResult[]): string =>
    JSON.stringify(
      planDocument({
        command: 'update',
        phase: 'plan',
        manager: 'npm',
        results,
      }),
    )
  const moving = (name: string, target: string): UpdateResult =>
    result({
      name,
      target,
      updated: true,
      reason: { code: 'within-range', message: 'within range' },
    })

  it('counts the rows that move', () => {
    expect(
      movingRows(document([moving('ms', '2.1.3'), moving('debug', '4.4.3')])),
    ).toBe(2)
  })

  it('leaves out the rows that are held or not targeted', () => {
    const rows = [
      moving('ms', '2.1.3'),
      result({
        name: 'debug',
        reason: {
          code: 'cooldown',
          message: 'cooldown: released 2d ago, requires 7d',
        },
      }),
      result({
        name: 'semver',
        reason: { code: 'not-targeted', message: 'not targeted' },
      }),
    ]

    expect(movingRows(document(rows))).toBe(1)
  })

  it('counts a cooldown fallback, which moves below its target', () => {
    const fallback = result({
      name: 'debug',
      target: '4.4.1',
      updated: true,
      reason: {
        code: 'cooldown-fallback',
        message: 'cooldown: 4.4.3 released 2d ago, requires 7d',
      },
    })

    expect(movingRows(document([fallback]))).toBe(1)
  })

  it('counts none in a document without rows', () => {
    expect(movingRows(document([]))).toBe(0)
  })

  it('still counts the rows of a 3.x array, for a build from before 4.0', () => {
    const rows = [
      { name: 'ms', target: '2.1.3', updated: true },
      { name: 'debug', updated: false, reason: 'cooldown: released 2d ago' },
    ]

    expect(movingRows(JSON.stringify(rows))).toBe(1)
    expect(movingRows('[]')).toBe(0)
  })

  it('throws autd’s message for the error document a failed run prints', () => {
    const failure = errorDocument('update', {
      step: 'discover',
      message: 'Could not look up 2 packages',
      manifestWritten: false,
    })

    expect(() => movingRows(JSON.stringify(failure))).toThrow(
      'Failed during discover: Could not look up 2 packages',
    )
    expect(() =>
      movingRows(
        JSON.stringify(
          errorDocument('update', {
            step: null,
            message: 'Bad config',
            manifestWritten: false,
          }),
        ),
      ),
    ).toThrow('Bad config')
  })

  it('throws on output that is not JSON, or neither rows nor an error', () => {
    expect(() => movingRows('Nothing to update')).toThrow(/printed no JSON/)
    expect(() => movingRows('')).toThrow(/printed no JSON/)
    expect(() => movingRows('{}')).toThrow(/neither rows nor an error/)
    expect(() => movingRows('"ok"')).toThrow(/neither rows nor an error/)
  })
})

describe('throttledLines', () => {
  it('finds the notice of the warm-up and of each timed run in real --show-output', () => {
    const lines = throttledLines(
      readFixture('hyperfine/show-output-throttled.txt'),
    )

    expect(lines).toHaveLength(3)
    for (const line of lines) {
      expect(line).toMatch(
        /Throttled by \S+ \(\d+ requests?\), so this run was slower than usual$/,
      )
    }
  })

  it('finds the same lines in output that carries color codes', () => {
    const lines = throttledLines(
      readFixture('hyperfine/show-output-throttled-color.txt'),
    )

    expect(lines).toEqual(
      throttledLines(readFixture('hyperfine/show-output-throttled.txt')),
    )
    expect(lines).toHaveLength(3)
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting no escape code is left
    for (const line of lines) expect(line).not.toMatch(/\u001b/)
  })

  it('finds nothing in the output of runs no host throttled', () => {
    expect(
      throttledLines(readFixture('hyperfine/show-output-clean.txt')),
    ).toEqual([])
  })

  it('finds what throttledNotice prints, for one request, many and two hosts', () => {
    const notices = [
      throttledNotice({ 'registry.npmjs.org': { throttled: 1 } }),
      throttledNotice({ 'registry.npmjs.org': { throttled: 40 } }),
      throttledNotice({
        'registry.npmjs.org': { throttled: 3 },
        'api.deps.dev': { throttled: 1 },
      }),
    ] as string[]

    for (const notice of notices) {
      expect(throttledLines(`before\n⚠️ ${notice}\nafter\n`)).toEqual([
        `⚠️ ${notice}`,
      ])
    }
  })
})

describe('renderTable', () => {
  it('pads the columns and right-aligns all but the first', () => {
    expect(
      renderTable(
        ['Manager', 'warm'],
        [
          ['npm 11.19.1', '0.92 s'],
          ['bun 1.4.4', '0.16 s'],
        ],
      ),
    ).toBe(
      [
        '| Manager     |   warm |',
        '|-------------|-------:|',
        '| npm 11.19.1 | 0.92 s |',
        '| bun 1.4.4   | 0.16 s |',
      ].join('\n'),
    )
  })
})

describe('medianDifference', () => {
  const timing = (median: number, mean = median * 3) => ({
    mean,
    stddev: 0,
    median,
    runs: 5,
  })

  it('subtracts the second median from the first, whatever the means say', () => {
    expect(medianDifference(timing(0.65, 2.5), timing(0.62, 0.4))).toBeCloseTo(
      0.03,
      10,
    )
  })

  it('is negative when the first is the faster', () => {
    expect(medianDifference(timing(0.1), timing(0.35))).toBeCloseTo(-0.25, 10)
  })
})

describe('fullPackumentReads', () => {
  it('finds the packument autd read in full in a real debug run', () => {
    expect(fullPackumentReads(readFixture('bench/check-debug.txt'))).toEqual([
      'ms',
    ])
  })

  it('lists each name once, sorted, scoped names included, without color', () => {
    const output = [
      '\u001b[90m  Reading the full packument of next for publish times: 1.0.0 has none\u001b[39m',
      '  Reading the full packument of @types/ms for publish times: 2.0.0 has none',
      '  Reading the full packument of next for publish times: 1.0.1 has none',
    ].join('\n')

    expect(fullPackumentReads(output)).toEqual(['@types/ms', 'next'])
  })

  it('ignores a 304, a failed request and a run that read none', () => {
    const output = [
      '  Revalidated the full packument of ms for publish times (304): 2.1.0 has none',
      '  Failed to read the full packument of debug: timeout',
    ].join('\n')

    expect(fullPackumentReads(output)).toEqual([])
    expect(fullPackumentReads('')).toEqual([])
  })
})

// A parsed document the tests damage in place, structuredClone-style variants of the real capture.
// biome-ignore lint/suspicious/noExplicitAny: the tests delete and overwrite fields the real type requires
type Loose = Record<string, any>

describe('parseBenchDocument', () => {
  const capture: Loose = JSON.parse(readFixture('bench/document.json'))
  const real = (): Loose => structuredClone(capture)

  it('reads a real document: the environment, a measured row and the startup pair', () => {
    const document = parseBenchDocument(readFixture('bench/document.json'))

    expect(document).toMatchObject({
      version: 1,
      autd: '3.4.0',
      project: 'pinned',
      platform: 'darwin',
    })
    const [row] = document.rows
    expect(row.status).toBe('measured')
    if (row.status !== 'measured') throw new Error('unreachable')
    expect(row.target).toBe('npm')
    expect(row.warm.runs).toBe(5)
    expect(row.cold.runs).toBe(3)
    expect(row.targets).toBe(39)
    expect(row.fullPackuments).toEqual([])
    expect(document.startup?.status).toBe('measured')
    if (document.startup?.status !== 'measured') throw new Error('unreachable')
    expect(document.startup.version.runs).toBe(80)
    expect(document.startup.version.median).toBeGreaterThan(
      document.startup.bare.median,
    )
  })

  it('round-trips through JSON unchanged', () => {
    const text = readFixture('bench/document.json')

    expect(JSON.parse(JSON.stringify(parseBenchDocument(text)))).toEqual(
      JSON.parse(text),
    )
  })

  it('reads failed and throttled rows, a failed startup and a missing one', () => {
    const document = real()
    document.rows = [
      { target: 'pnpm', status: 'failed', error: 'install failed' },
      { target: 'bun', status: 'throttled', error: 'Throttled by x' },
    ]
    document.startup = { status: 'failed', error: 'no hyperfine' }

    expect(parseBenchDocument(JSON.stringify(document))).toMatchObject({
      rows: [
        { target: 'pnpm', status: 'failed', error: 'install failed' },
        { target: 'bun', status: 'throttled' },
      ],
      startup: { status: 'failed', error: 'no hyperfine' },
    })

    delete document.startup
    expect(parseBenchDocument(JSON.stringify(document)).startup).toBeUndefined()
  })

  it('keeps the packuments a debug run listed', () => {
    const document = real()
    document.rows[0].fullPackuments = ['next']

    const [row] = parseBenchDocument(JSON.stringify(document)).rows
    expect(row).toMatchObject({ fullPackuments: ['next'] })
  })

  it('leaves fullPackuments out of a row whose debug run failed', () => {
    const document = real()
    delete document.rows[0].fullPackuments

    const [row] = parseBenchDocument(JSON.stringify(document)).rows
    expect('fullPackuments' in row).toBe(false)
  })

  it.each([
    ['not JSON', (_: Loose) => undefined, /not JSON/],
    [
      'a version other than 1',
      (d: Loose) => {
        d.version = 2
      },
      /version is not 1/,
    ],
    [
      'rows that are not a list',
      (d: Loose) => {
        d.rows = {}
      },
      /rows is not a list/,
    ],
    [
      'a missing autd version',
      (d: Loose) => {
        delete d.autd
      },
      /document\.autd is not a string/,
    ],
    [
      'an unknown target',
      (d: Loose) => {
        d.rows[0].target = 'deno'
      },
      /rows\[0\]\.target is not one of/,
    ],
    [
      'an unknown status',
      (d: Loose) => {
        d.rows[0].status = 'slow'
      },
      /rows\[0\]\.status is not measured, failed or throttled/,
    ],
    [
      'a missing metric',
      (d: Loose) => {
        delete d.rows[0].cooldownCold
      },
      /rows\[0\]\.cooldownCold is not an object/,
    ],
    [
      'a timing without a median',
      (d: Loose) => {
        delete d.rows[0].cold.median
      },
      /rows\[0\]\.cold\.median is not a number/,
    ],
    [
      'a timing with a text number',
      (d: Loose) => {
        d.rows[0].warm.mean = '0.1'
      },
      /rows\[0\]\.warm\.mean is not a number/,
    ],
    [
      'a failed row without its error',
      (d: Loose) => {
        d.rows = [{ target: 'npm', status: 'failed' }]
      },
      /rows\[0\]\.error is not a string/,
    ],
    [
      'packuments that are not strings',
      (d: Loose) => {
        d.rows[0].fullPackuments = [1]
      },
      /fullPackuments is not a list of strings/,
    ],
    [
      'a startup without its bare timing',
      (d: Loose) => {
        delete d.startup.bare
      },
      /startup\.bare is not an object/,
    ],
  ])('rejects %s', (_name, damage, message) => {
    const document = real()
    const text =
      _name === 'not JSON'
        ? 'nope'
        : (damage(document), JSON.stringify(document))

    expect(() => parseBenchDocument(text)).toThrow(message)
  })
})
