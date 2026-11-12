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

const DURATION = /^(\d+(?:\.\d+)?)\s*([a-z]*)$/

/**
 * Read a duration into days, or undefined when it is not one. Accepts:
 *   - a number of days: finite and not negative
 *   - a string with a unit ('1 week', '7 days', '24h', '2 months', any case)
 *   - a bare numeric string ('7' → 7 days)
 * Nothing else: no sign, exponent, hex or leading dot, which is also what
 * `schema/config.schema.json`'s pattern allows. The config loader uses this
 * to reject what it cannot read.
 */
export const readDuration = (
  value: number | string | undefined,
): number | undefined => {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : undefined
  }
  if (typeof value !== 'string') return undefined

  const match = value.trim().toLowerCase().match(DURATION)
  if (!match) return undefined

  const [, numStr, unit] = match
  const multiplier = unit === '' ? 1 : UNIT_TO_DAYS[unit]
  if (multiplier === undefined) return undefined

  const days = Number(numStr) * multiplier
  return Number.isFinite(days) ? days : undefined
}

/**
 * `readDuration`, with 0 for anything unreadable so callers can fail open.
 * The cooldown gate uses this on a config the loader has already validated.
 */
export const parseDuration = (value: number | string | undefined): number =>
  readDuration(value) ?? 0

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
