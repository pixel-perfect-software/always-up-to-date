import semver from 'semver'
import type { RegistryPackage } from '@/types'

/**
 * The version a range allows, the same rule for every manager:
 * 1. an exact pin (`1.2.3`, `=1.2.3`, `v1.2.3`) is its own,
 * 2. otherwise `latest`, when it satisfies the range and isn't deprecated
 *    (`preferLatest`; yarn berry will turn it off),
 * 3. otherwise the highest satisfying version that isn't deprecated,
 * 4. otherwise the highest satisfying version.
 * Prereleases follow semver's default: one satisfies a range only when a
 * comparator with the same `[major, minor, patch]` names a prerelease.
 * Undefined when no published version satisfies the range.
 */
export const wantedVersion = (
  range: string,
  pkg: RegistryPackage,
  { preferLatest = true }: { preferLatest?: boolean } = {},
): string | undefined => {
  const pinned = semver.clean(range)
  if (pinned) return pinned

  const satisfying = pkg.versions.filter((candidate) =>
    semver.satisfies(candidate.version, range),
  )
  if (satisfying.length === 0) return undefined

  if (preferLatest) {
    const latest = satisfying.find(
      (candidate) => candidate.version === pkg.latest && !candidate.deprecated,
    )
    if (latest) return latest.version
  }
  return (
    satisfying.findLast((candidate) => !candidate.deprecated) ??
    satisfying[satisfying.length - 1]
  ).version
}
