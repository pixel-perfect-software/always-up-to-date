import semver from 'semver'
import type { CooldownConfig, UpdateResult } from '@/types'
import { cooldownDaysFor, evaluateCooldown } from '@/utils/cooldown'
import { formatAgeDays } from '@/utils/duration'
import { stepType } from './rows'
import type { DeclaredOf, PlanRegistry } from './types'

/**
 * The newest version between `current` and a target the cooldown held that
 * is past cooldown for its own step and not deprecated (#147), so a package
 * that publishes more often than the cooldown still moves. It is below the
 * target, so the policy allows a step no larger. Below `wanted` it must also
 * satisfy `range`, the one the manifest declares: `applyPinned` puts that
 * range back after the pin, and the manager keeps the version only if the
 * range allows it, which a range with a gap (`^1 || ^3`) need not (#151).
 * With no range known, nothing below `wanted` qualifies. A pre-release only
 * when the target is one.
 */
const cooledOffVersion = (
  { current, wanted, target }: UpdateResult,
  range: string | undefined,
  times: Record<string, string>,
  deprecated: Set<string>,
  cooldown: CooldownConfig | undefined,
  now: number | undefined,
): { version: string; ageDays: number | undefined } | undefined => {
  if (!target || !semver.valid(current) || !semver.valid(target)) {
    return undefined
  }
  const preRelease = semver.prerelease(target) !== null
  const candidates = Object.keys(times)
    .filter(
      (version) =>
        semver.valid(version) &&
        semver.gt(version, current) &&
        semver.lt(version, target) &&
        (preRelease || semver.prerelease(version) === null) &&
        !deprecated.has(version) &&
        // At `wanted` the manager installs it by name; past it, the spec is
        // rewritten to it.
        ((semver.valid(wanted) !== null && semver.gte(version, wanted)) ||
          (range !== undefined && semver.satisfies(version, range))),
    )
    .sort(semver.rcompare)
  for (const version of candidates) {
    const evaluation = evaluateCooldown(
      times[version],
      stepType(current, version),
      cooldown,
      now,
    )
    if (!evaluation.gated) return { version, ageDays: evaluation.ageDays }
  }
  return undefined
}

/** Versions the registry marks deprecated, when the session can say. */
const deprecatedVersions = async (
  registry: PlanRegistry,
  name: string,
): Promise<Set<string>> => {
  const lookup = await registry.lookup?.(name)
  return new Set(
    lookup?.ok
      ? lookup.package.versions
          .filter((v) => v.deprecated)
          .map((v) => v.version)
      : [],
  )
}

/**
 * The cooldown gate on each moving row's target: a target too fresh for its
 * step falls back to `cooledOffVersion` (`cooldown-fallback`, the row still
 * moving) or, with none, is held (`cooldown`, the target kept as `judged`).
 * A row whose step has a zero-day cooldown is not asked about and keeps no
 * `releaseAge`. Release times are those of the name discovery looked up
 * (`declared`, an alias's target, #152), asked with the row's window.
 */
export const holdCooldown = (
  results: UpdateResult[],
  {
    cooldown,
    registry,
    declared,
    now,
  }: {
    cooldown: CooldownConfig | undefined
    registry: PlanRegistry
    declared: DeclaredOf | undefined
    now: number | undefined
  },
): Promise<UpdateResult[]> =>
  Promise.all(
    results.map(async (result): Promise<UpdateResult> => {
      if (!result.updated || !result.target) return result
      // A zero-day step is never gated, whatever its release time is.
      if (cooldownDaysFor(cooldown, result.updateType) <= 0) {
        return { ...result, releaseAge: undefined }
      }

      const dependency = declared?.({
        name: result.name,
        workspace: result.workspace,
      })
      // A row is keyed by its manifest key; an alias's dates are its target's.
      const name = dependency?.name ?? result.name
      const releaseTimes = await registry.releaseTimes(name, {
        current: result.current,
        target: result.target,
      })
      const releaseTime = releaseTimes[result.target]
      const evaluation = evaluateCooldown(
        releaseTime,
        result.updateType,
        cooldown,
        now,
      )

      if (evaluation.gated) {
        const held = evaluation.unknown
          ? `release date unknown, requires ${evaluation.requiredDays}d`
          : `released ${formatAgeDays(
              evaluation.ageDays,
            )} ago, requires ${evaluation.requiredDays}d`
        const fallback = cooledOffVersion(
          result,
          dependency && 'range' in dependency.spec
            ? dependency.spec.range
            : undefined,
          releaseTimes,
          await deprecatedVersions(registry, name),
          cooldown,
          now,
        )
        if (fallback) {
          return {
            ...result,
            target: fallback.version,
            updateType: stepType(result.current, fallback.version),
            reason: {
              code: 'cooldown-fallback',
              message: `cooldown: ${result.target} ${held}`,
            },
            releaseAge: fallback.ageDays,
          }
        }
        return {
          ...result,
          target: undefined,
          judged: result.target,
          updated: false,
          reason: { code: 'cooldown', message: `cooldown: ${held}` },
          releaseAge: evaluation.ageDays,
        }
      }

      return { ...result, releaseAge: evaluation.ageDays }
    }),
  )

/**
 * What the cooldown says of one version below a row's target, for the
 * engines walk-back (#200): not gated when its step has a zero-day cooldown,
 * else judged by the publish time the row's window (`current` to the
 * target, as the cooldown gate asked) gives it.
 */
export const versionCooldown =
  ({
    cooldown,
    registry,
    lookupName,
    now,
  }: {
    cooldown: CooldownConfig | undefined
    registry: PlanRegistry
    lookupName: (row: UpdateResult) => string
    now: number | undefined
  }) =>
  async (
    row: UpdateResult,
    version: string,
  ): Promise<{ gated: boolean; ageDays: number | undefined }> => {
    const type = stepType(row.current, version)
    if (cooldownDaysFor(cooldown, type) <= 0) {
      return { gated: false, ageDays: undefined }
    }
    const times = await registry.releaseTimes(lookupName(row), {
      current: row.current,
      target: row.target as string,
    })
    const { gated, ageDays } = evaluateCooldown(
      times[version],
      type,
      cooldown,
      now,
    )
    return { gated, ageDays }
  }
