import semver from 'semver'
import type {
  AlwaysUpToDateConfig,
  BeyondRange,
  PackageInfo,
  PackageRule,
} from '@/types'

/** The override layer as the policy reads it, built from the config file. */
export interface UpdatePolicy {
  beyondRange: BeyondRange
  ruleFor: (name: string) => PackageRule | undefined
}

/** `target` is set when the package should move; `reason` when it is held. */
export interface UpdateDecision {
  target?: string
  reason?: string
}

const LEVEL_RANK: Record<BeyondRange, number> = {
  none: 0,
  patch: 1,
  minor: 2,
  major: 3,
}

/**
 * The legacy fields act as the override layer: `allowMinorUpdates` and
 * `allowMajorUpdates` say how far beyond the range a package may move, the
 * allowlist means "always latest" and the denylist means "hold". The
 * allowlist wins when a package is on both.
 */
export const policyFromConfig = (
  config: AlwaysUpToDateConfig,
): UpdatePolicy => ({
  beyondRange: config.allowMajorUpdates
    ? 'major'
    : config.allowMinorUpdates
      ? 'minor'
      : 'none',
  ruleFor: (name) => {
    if (config.updateAllowlist.includes(name)) return 'latest'
    if (config.updateDenylist.includes(name)) return 'hold'
    return undefined
  },
})

/** Size of the step from `from` to `to`; pre-releases count as their level. */
export const stepLevel = (
  from: string,
  to: string,
): Exclude<BeyondRange, 'none'> => {
  switch (semver.diff(from, to)) {
    case 'major':
    case 'premajor':
      return 'major'
    case 'minor':
    case 'preminor':
      return 'minor'
    default:
      return 'patch'
  }
}

/**
 * Decides where one outdated package should move. By default it stays within
 * its manifest range (`wanted`), so an exact pin is held. The policy can
 * allow moving past the range to `latest`, up to a step size, or override a
 * single package with a rule.
 */
const updateChecker = (
  { current, wanted, latest, name }: PackageInfo,
  policy: UpdatePolicy,
): UpdateDecision => {
  if (!semver.valid(current) || !semver.valid(latest)) {
    return { reason: `invalid version (current ${current}, latest ${latest})` }
  }

  const rule = policy.ruleFor(name)
  if (rule === 'hold') return { reason: 'held by rule' }
  if (!semver.gt(latest, current)) return { reason: 'not newer than installed' }
  if (rule === 'latest') return { target: latest }

  const inRange =
    semver.valid(wanted) && semver.gt(wanted, current) ? wanted : undefined
  const latestOutsideRange = semver.gt(latest, inRange ?? current)
  const step = stepLevel(current, latest)

  if (
    latestOutsideRange &&
    rule !== 'followRange' &&
    LEVEL_RANK[step] <= LEVEL_RANK[policy.beyondRange]
  ) {
    return { target: latest }
  }

  if (inRange) return { target: inRange }

  return {
    reason:
      rule === 'followRange'
        ? 'outside the range (rule followRange)'
        : `${step} beyond the range`,
  }
}

export default updateChecker
