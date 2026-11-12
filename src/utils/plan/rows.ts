import semver, { type ReleaseType } from 'semver'
import type { Reason, UpdateResult } from '@/types'

/**
 * `semver.diff`, or null when either version isn't semver: managers report
 * versions such as yarn v1's `exotic` for an npm: alias, and `semver.diff`
 * throws on them.
 */
export const stepType = (from: string, to: string): ReleaseType | null =>
  semver.valid(from) && semver.valid(to) ? semver.diff(from, to) : null

/**
 * A moving row's warnings, one after another; the same one (code and
 * message) is never added twice.
 */
export const withWarning = (
  result: UpdateResult,
  warning: Reason,
): UpdateResult =>
  result.warnings?.some(
    (w) => w.code === warning.code && w.message === warning.message,
  )
    ? result
    : { ...result, warnings: [...(result.warnings ?? []), warning] }

/**
 * A moving row held for `reason`: no target, and its `updateType` is `current
 * → latest`; `judged` keeps the target the hold judged (#221).
 */
export const heldFor = (
  result: UpdateResult,
  reason: Reason,
): UpdateResult => ({
  ...result,
  target: undefined,
  judged: result.target ?? result.judged,
  updated: false,
  updateType: stepType(result.current, result.latest),
  reason,
})
