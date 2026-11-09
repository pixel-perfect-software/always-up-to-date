/**
 * The outcomes a planned row can have in the `--json` document, and the codes
 * of the reasons behind them (#201). Pure and importing nothing, as
 * `src/managers/names.ts` is, so anything may import it without a load cost.
 * A new reason needs a code here and a section in `report.ts`'s `SECTION_OF`.
 */
export const OUTCOMES = [
  'update',
  'held',
  'not-applied',
  'not-targeted',
] as const

export const REASON_CODES = [
  // moving
  'within-range',
  'past-range',
  'rule-latest',
  'cooldown-fallback',
  'engines-fallback',
  // held
  'invalid-version',
  'not-installed',
  'not-newer',
  'rule-hold',
  'rule-follow-range',
  'outside-range',
  'override',
  'peer-conflict',
  'target-peers',
  'cooldown',
  'deprecated',
  'license-change',
  'engines',
  'held-with',
  // after apply, or not asked for
  'not-applied',
  'not-targeted',
] as const
