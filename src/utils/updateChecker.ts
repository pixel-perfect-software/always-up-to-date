import semver from 'semver'
import type {
  AlwaysUpToDateConfig,
  BeyondRange,
  PackageInfo,
  PackageRule,
  Reason,
} from '@/types'

/** The override layer as the policy reads it, built from the config file. */
export interface UpdatePolicy {
  beyondRange: BeyondRange
  ruleFor: (name: string) => PackageRule | undefined
}

/** Where the package moves, or why it is held; either way, the reason. */
export type UpdateDecision =
  | { target: string; reason: Reason }
  | { target?: undefined; reason: Reason }

const LEVEL_RANK: Record<BeyondRange, number> = {
  none: 0,
  patch: 1,
  minor: 2,
  major: 3,
}

const escapeRegExp = (text: string): string =>
  text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** `*` matches any run of characters; everything else is literal. */
const globToRegExp = (pattern: string): RegExp =>
  new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`)

/**
 * Builds the override layer from the config. `beyondRange` and `rules` win
 * over the deprecated fields: `allowMinorUpdates` / `allowMajorUpdates` give
 * the level only when `beyondRange` is unset, and the allow/deny lists act as
 * `latest` / `hold` rules only for packages no rule matches. A rule for the
 * exact name beats any glob; among globs the longest pattern wins.
 */
export const policyFromConfig = (
  config: AlwaysUpToDateConfig,
): UpdatePolicy => {
  const rules = config.rules ?? {}
  const globs = Object.entries(rules)
    .filter(([pattern]) => pattern.includes('*'))
    .sort(([a], [b]) => b.length - a.length)
    .map(([pattern, rule]) => ({ matches: globToRegExp(pattern), rule }))

  const legacyLevel: BeyondRange = config.allowMajorUpdates
    ? 'major'
    : config.allowMinorUpdates
      ? 'minor'
      : 'none'

  return {
    beyondRange: config.beyondRange ?? legacyLevel,
    ruleFor: (name) => {
      if (Object.hasOwn(rules, name)) return rules[name]
      const glob = globs.find(({ matches }) => matches.test(name))
      if (glob) return glob.rule
      if (config.updateAllowlist.includes(name)) return 'latest'
      if (config.updateDenylist.includes(name)) return 'hold'
      return undefined
    },
  }
}

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
    return {
      reason: {
        code: current === 'missing' ? 'not-installed' : 'invalid-version',
        message: `invalid version (current ${current}, latest ${latest})`,
      },
    }
  }

  const rule = policy.ruleFor(name)
  if (rule === 'hold') {
    return { reason: { code: 'rule-hold', message: 'held by rule' } }
  }
  if (!semver.gt(latest, current)) {
    return {
      reason: { code: 'not-newer', message: 'not newer than installed' },
    }
  }
  if (rule === 'latest') {
    return {
      target: latest,
      reason: { code: 'rule-latest', message: 'rule "latest"' },
    }
  }

  const inRange =
    semver.valid(wanted) && semver.gt(wanted, current) ? wanted : undefined
  const latestOutsideRange = semver.gt(latest, inRange ?? current)
  const step = stepLevel(current, latest)

  if (
    latestOutsideRange &&
    rule !== 'followRange' &&
    LEVEL_RANK[step] <= LEVEL_RANK[policy.beyondRange]
  ) {
    return {
      target: latest,
      reason: {
        code: 'past-range',
        message: `past its range, "beyondRange": "${policy.beyondRange}"`,
      },
    }
  }

  if (inRange) {
    return {
      target: inRange,
      reason: { code: 'within-range', message: 'within range' },
    }
  }

  return {
    reason:
      rule === 'followRange'
        ? {
            code: 'rule-follow-range',
            message: 'outside the range (rule followRange)',
          }
        : { code: 'outside-range', message: `${step} beyond the range` },
  }
}

export default updateChecker
