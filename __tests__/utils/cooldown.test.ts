import {
  cooldownDaysFor,
  evaluateCooldown,
  isCooldownEnabled,
  normalizeCooldown,
} from '@/utils/cooldown'

const NOW = Date.parse('2026-04-29T12:00:00Z')
const daysAgo = (days: number) =>
  new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString()

describe('normalizeCooldown', () => {
  it('treats a number as the same window for all update types', () => {
    expect(normalizeCooldown(7)).toEqual({ patch: 7, minor: 7, major: 7 })
  })

  it('treats a string the same way', () => {
    expect(normalizeCooldown('1 week')).toEqual({
      patch: 7,
      minor: 7,
      major: 7,
    })
  })

  it('fills missing keys with 0', () => {
    expect(normalizeCooldown({ minor: 7 })).toEqual({
      patch: 0,
      minor: 7,
      major: 0,
    })
  })

  it('parses string values inside the object form', () => {
    expect(
      normalizeCooldown({ patch: '12h', minor: '1 week', major: '1 month' }),
    ).toEqual({ patch: 0.5, minor: 7, major: 30 })
  })

  it('handles undefined as zero across the board', () => {
    expect(normalizeCooldown(undefined)).toEqual({
      patch: 0,
      minor: 0,
      major: 0,
    })
  })
})

describe('isCooldownEnabled', () => {
  it('is false for zero', () => {
    expect(isCooldownEnabled(0)).toBe(false)
  })

  it('is true for any positive window', () => {
    expect(isCooldownEnabled(1)).toBe(true)
    expect(isCooldownEnabled({ minor: 7 })).toBe(true)
    expect(isCooldownEnabled('1 week')).toBe(true)
  })

  it('is false for an all-zero object', () => {
    expect(isCooldownEnabled({ patch: 0, minor: 0, major: 0 })).toBe(false)
  })
})

describe('cooldownDaysFor', () => {
  it('routes prerelease types into their base buckets', () => {
    expect(
      cooldownDaysFor({ patch: 1, minor: 2, major: 3 }, 'prerelease'),
    ).toBe(1)
    expect(cooldownDaysFor({ patch: 1, minor: 2, major: 3 }, 'preminor')).toBe(
      2,
    )
    expect(cooldownDaysFor({ patch: 1, minor: 2, major: 3 }, 'premajor')).toBe(
      3,
    )
  })

  it('returns 0 for null update type', () => {
    expect(cooldownDaysFor(7, null)).toBe(0)
  })
})

describe('evaluateCooldown', () => {
  it('passes through when cooldown is zero', () => {
    const result = evaluateCooldown(daysAgo(0), 'patch', 0, NOW)
    expect(result.gated).toBe(false)
    expect(result.requiredDays).toBe(0)
  })

  it('gates a fresh release', () => {
    const result = evaluateCooldown(daysAgo(2), 'patch', 7, NOW)
    expect(result.gated).toBe(true)
    expect(result.requiredDays).toBe(7)
    expect(Math.round(result.ageDays!)).toBe(2)
  })

  it('lets a release through once it crosses the threshold', () => {
    const result = evaluateCooldown(daysAgo(8), 'patch', 7, NOW)
    expect(result.gated).toBe(false)
    expect(Math.round(result.ageDays!)).toBe(8)
  })

  it('applies the right window per release type', () => {
    const cooldown = { patch: 1, minor: 7, major: 30 }
    expect(evaluateCooldown(daysAgo(3), 'minor', cooldown, NOW).gated).toBe(
      true,
    )
    expect(evaluateCooldown(daysAgo(10), 'minor', cooldown, NOW).gated).toBe(
      false,
    )
    expect(evaluateCooldown(daysAgo(10), 'major', cooldown, NOW).gated).toBe(
      true,
    )
  })

  it('honors string-form cooldown windows', () => {
    expect(evaluateCooldown(daysAgo(3), 'minor', '1 week', NOW).gated).toBe(
      true,
    )
    expect(evaluateCooldown(daysAgo(10), 'minor', '1 week', NOW).gated).toBe(
      false,
    )
  })

  it('fails open when release time is missing', () => {
    const result = evaluateCooldown(undefined, 'patch', 7, NOW)
    expect(result.gated).toBe(false)
    expect(result.ageDays).toBeUndefined()
  })

  it('fails open on unparseable timestamps', () => {
    const result = evaluateCooldown('not-a-date', 'patch', 7, NOW)
    expect(result.gated).toBe(false)
  })
})
