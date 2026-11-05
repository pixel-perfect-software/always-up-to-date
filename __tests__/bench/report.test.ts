import {
  formatDifference,
  formatMemory,
  formatSeconds,
  formatTiming,
  hyperfineMajor,
  movingRows,
  parseHyperfine,
  renderTable,
  throttledLines,
} from '../../bench/report'
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
  const row = (fields: object): object => ({
    name: 'ms',
    current: '2.0.0',
    wanted: '2.0.0',
    latest: '2.1.3',
    updateType: 'minor',
    ...fields,
  })

  it('counts the rows that move', () => {
    const rows = [
      row({ name: 'ms', target: '2.1.3', updated: true }),
      row({ name: 'debug', target: '4.4.3', updated: true }),
    ]

    expect(movingRows(JSON.stringify(rows))).toBe(2)
  })

  it('leaves out the rows that are held or not targeted', () => {
    const rows = [
      row({ name: 'ms', target: '2.1.3', updated: true }),
      row({
        name: 'debug',
        updated: false,
        reason: 'cooldown: released 2d ago, requires 7d',
      }),
      row({ name: 'semver', updated: false, reason: 'not targeted' }),
    ]

    expect(movingRows(JSON.stringify(rows))).toBe(1)
  })

  it('counts a cooldown fallback, which moves below its target', () => {
    const rows = [
      row({
        name: 'debug',
        target: '4.4.1',
        updated: true,
        reason: 'cooldown: 4.4.3 released 2d ago, requires 7d',
      }),
    ]

    expect(movingRows(JSON.stringify(rows))).toBe(1)
  })

  it('counts none in an empty list', () => {
    expect(movingRows('[]')).toBe(0)
  })

  it('throws autd’s message for the error document a failed run prints', () => {
    const failure = {
      error: {
        step: 'discover',
        message: 'Could not look up 2 packages',
        manifestWritten: false,
      },
    }

    expect(() => movingRows(JSON.stringify(failure))).toThrow(
      'Failed during discover: Could not look up 2 packages',
    )
    expect(() =>
      movingRows(JSON.stringify({ error: { message: 'Bad config' } })),
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
