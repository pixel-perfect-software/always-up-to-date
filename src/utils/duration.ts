export const MS_PER_DAY = 24 * 60 * 60 * 1000

const UNIT_TO_DAYS: Record<string, number> = {
  s: 1 / 86_400,
  sec: 1 / 86_400,
  second: 1 / 86_400,
  seconds: 1 / 86_400,
  m: 1 / 1_440,
  min: 1 / 1_440,
  minute: 1 / 1_440,
  minutes: 1 / 1_440,
  h: 1 / 24,
  hr: 1 / 24,
  hour: 1 / 24,
  hours: 1 / 24,
  d: 1,
  day: 1,
  days: 1,
  w: 7,
  wk: 7,
  week: 7,
  weeks: 7,
  mo: 30,
  month: 30,
  months: 30,
  y: 365,
  yr: 365,
  year: 365,
  years: 365,
}

/**
 * Parse a duration into days. Accepts:
 *   - a number (interpreted as days)
 *   - a string with a unit ('1 week', '7 days', '24h', '2 months')
 *   - a bare numeric string ('7' → 7 days)
 * Returns 0 for anything unparseable so callers can fail open.
 */
export const parseDuration = (value: number | string | undefined): number => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : 0
  }
  if (typeof value !== 'string') return 0

  const trimmed = value.trim().toLowerCase()
  if (!trimmed) return 0

  const bareNumber = Number(trimmed)
  if (!Number.isNaN(bareNumber) && Number.isFinite(bareNumber)) {
    return bareNumber >= 0 ? bareNumber : 0
  }

  const match = trimmed.match(/^(\d+(?:\.\d+)?)\s*([a-z]+)$/)
  if (!match) return 0

  const [, numStr, unit] = match
  const multiplier = UNIT_TO_DAYS[unit]
  if (multiplier === undefined) return 0

  const days = Number(numStr) * multiplier
  return Number.isFinite(days) && days >= 0 ? days : 0
}

/**
 * Render an age in days as a short human-readable string.
 * Sub-day ages collapse to hours; otherwise floor to whole days.
 */
export const formatAgeDays = (ageDays: number | undefined): string => {
  if (ageDays === undefined) return 'unknown age'
  if (ageDays < 1) {
    const hours = Math.max(1, Math.round(ageDays * 24))
    return `${hours}h`
  }
  return `${Math.floor(ageDays)}d`
}
