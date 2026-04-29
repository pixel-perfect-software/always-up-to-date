import { formatAgeDays, parseDuration } from '@/utils/duration'

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

  it.each([
    undefined,
    '',
    'gibberish',
    '5 fortnights',
    -3,
    NaN,
    Infinity,
  ])('returns 0 for invalid input %j', (input) => {
    expect(parseDuration(input as never)).toBe(0)
  })
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
