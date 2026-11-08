import type { UpdateResult } from '@/types'

/** Moving codes whose reason the 3.x document never carried. */
const UNSTATED = new Set(['within-range', 'past-range', 'rule-latest'])

/**
 * A row as the 3.x `--json` document printed it: `reason` and `warning` as
 * strings, in the keys' original places. Temporary: #201's document replaces
 * it in the next phase.
 */
export const legacyRow = (row: UpdateResult): Record<string, unknown> =>
  Object.fromEntries(
    Object.entries(row).flatMap(([key, value]): [string, unknown][] => {
      if (key === 'reason') {
        return UNSTATED.has(row.reason.code) ? [] : [[key, row.reason.message]]
      }
      if (key === 'warnings') {
        const warnings = row.warnings ?? []
        return warnings.length === 0
          ? []
          : [['warning', warnings.map((w) => w.message).join('; ')]]
      }
      return [[key, value]]
    }),
  )
