import fs from 'fs'
import path from 'path'
import { formatAgeDays, parseDuration, readDuration } from '@/utils/duration'

describe('parseDuration', () => {
  it.each([
    ['1 day', 1],
    ['7 days', 7],
    ['1 week', 7],
    ['2 weeks', 14],
    ['1 month', 30],
    ['1 year', 365],
    ['24 hours', 1],
    ['12h', 0.5],
    ['30 minutes', 30 / 1440],
    ['7d', 7],
    ['1w', 7],
    ['2mo', 60],
    ['  3 days  ', 3],
    ['1 DAY', 1],
    ['1.5 days', 1.5],
  ])('parses %j → %s days', (input, expected) => {
    expect(parseDuration(input)).toBeCloseTo(expected, 6)
  })

  it('treats bare numeric strings as days', () => {
    expect(parseDuration('5')).toBe(5)
  })

  it('passes through valid numbers unchanged', () => {
    expect(parseDuration(7)).toBe(7)
  })

  it.each([undefined, '', 'gibberish', '5 fortnights', -3, NaN, Infinity])(
    'returns 0 for invalid input %j',
    (input) => {
      expect(parseDuration(input as never)).toBe(0)
    },
  )
})

describe('readDuration', () => {
  it.each([
    ['7', 7],
    ['1 week', 7],
    ['1 Week', 7],
    ['24h', 1],
    ['0.5 days', 0.5],
    [0, 0],
    [7, 7],
  ])('reads %j as %j days', (input, days) => {
    expect(readDuration(input)).toBe(days)
  })

  it.each([
    '30 dyas',
    '1 wek',
    '',
    '  ',
    '-3',
    '+3',
    '1e3',
    '0x10',
    '.5',
    'Infinity',
    '5 fortnights',
    -3,
    NaN,
    Infinity,
    undefined,
  ])('returns undefined for %j', (input) => {
    expect(readDuration(input as never)).toBeUndefined()
  })
})

// The loader accepts what `readDuration` reads, and the schema says so to an editor.
describe('schema/config.schema.json duration pattern', () => {
  const schema = JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '../../schema/config.schema.json'),
      'utf8',
    ),
  )
  const patterns: string[] = [
    schema.properties.cooldown.oneOf[1].pattern,
    schema.definitions.cooldownValue.oneOf[1].pattern,
  ]
  const samples = [
    '7',
    '7.5',
    ' 7 ',
    '1 week',
    '1 Week',
    '1WEEK',
    '24h',
    '24 H',
    '2 months',
    '1 yr',
    '1 wek',
    '30 dyas',
    '5 fortnights',
    '-3',
    '+3',
    '1e3',
    '0x10',
    '.5',
    '5.',
    '',
    ' ',
    'week',
    '1 week 2',
    '1 w eek',
    'Infinity',
  ]

  it.each(patterns.map((p, i) => [i, p] as const))(
    'pattern %i matches exactly the strings readDuration reads',
    (_, pattern) => {
      const re = new RegExp(pattern)
      for (const sample of samples) {
        expect([sample, re.test(sample)]).toEqual([
          sample,
          readDuration(sample) !== undefined,
        ])
      }
    },
  )
})

describe('formatAgeDays', () => {
  it('renders sub-day ages in hours', () => {
    expect(formatAgeDays(0.5)).toBe('12h')
  })

  it('floors multi-day ages', () => {
    expect(formatAgeDays(3.7)).toBe('3d')
  })

  it('handles undefined gracefully', () => {
    expect(formatAgeDays(undefined)).toBe('unknown age')
  })
})
