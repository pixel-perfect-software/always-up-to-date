import semver from 'semver'
import type {
  PackageInfo,
  SupportedPackageManager,
  UpdateResult,
} from '@/types'
import { loadConfig } from './config'
import { evaluateCooldown, isCooldownEnabled } from './cooldown'
import { formatAgeDays } from './duration'
import { loadRegistryConfig } from './npmrcLoader'
import { findControllingOverrides } from './overrides'
import { fetchReleaseTimes } from './registry'
import updateChecker, { policyFromConfig } from './updateChecker'

interface FilterPackagesOptions {
  targetPackages?: string[]
  cwd?: string
  now?: number
  /** Whose override fields to honor; without it no package is held for one. */
  packageManager?: SupportedPackageManager
}

/**
 * Decides each outdated package's target (`updateChecker`: within the
 * manifest range by default, further only when the policy allows), then
 * applies the cooldown gate to that target. Network calls only happen for
 * packages with a target, and never when `cooldown` is 0 (the default).
 */
const filterPackages = async (
  outdatedPackages: Record<string, PackageInfo>,
  options: FilterPackagesOptions = {},
): Promise<UpdateResult[]> => {
  const { targetPackages, cwd = process.cwd(), now, packageManager } = options
  const config = loadConfig(cwd)
  const policy = policyFromConfig(config)
  const controlled = packageManager
    ? findControllingOverrides(cwd, packageManager)
    : {}
  const cooldownActive = isCooldownEnabled(config.cooldown)
  const registryConfig = cooldownActive ? loadRegistryConfig(cwd) : undefined

  const initialResults: UpdateResult[] = Object.entries(outdatedPackages).map(
    ([name, packageInfo]) => {
      const { current, wanted, latest } = packageInfo

      if (
        targetPackages &&
        targetPackages.length > 0 &&
        !targetPackages.includes(name)
      ) {
        return {
          name,
          current,
          wanted,
          latest,
          updateType: semver.diff(current, latest),
          updated: false,
          reason: 'not targeted',
        }
      }

      const { target, reason } = updateChecker({ ...packageInfo, name }, policy)

      // The manager enforces an override whatever a rule says: a target
      // outside its range cannot take effect. (npm requires a direct
      // dependency's override to equal its own spec, so in-range targets pass.)
      // A held package names the override when latest is outside it too,
      // since that is what keeps it in place.
      const override = controlled[name]
      if (override && !semver.satisfies(target ?? latest, override.range)) {
        return {
          name,
          current,
          wanted,
          latest,
          updateType: semver.diff(current, latest),
          updated: false,
          reason: `controlled by ${override.field} (${override.range})`,
        }
      }

      return {
        name,
        current,
        wanted,
        latest,
        target,
        updateType: semver.diff(current, target ?? latest),
        updated: target !== undefined,
        reason,
      }
    },
  )

  if (!cooldownActive || !registryConfig) return initialResults

  return Promise.all(
    initialResults.map(async (result) => {
      if (!result.updated || !result.target) return result

      const releaseTimes = await fetchReleaseTimes(result.name, registryConfig)
      const releaseTime = releaseTimes[result.target]
      const evaluation = evaluateCooldown(
        releaseTime,
        result.updateType,
        config.cooldown,
        now,
      )

      if (evaluation.gated) {
        return {
          ...result,
          target: undefined,
          updated: false,
          reason: `cooldown: released ${formatAgeDays(
            evaluation.ageDays,
          )} ago, requires ${evaluation.requiredDays}d`,
          releaseAge: evaluation.ageDays,
        }
      }

      return { ...result, releaseAge: evaluation.ageDays }
    }),
  )
}

/**
 * Splits the updates the policy chose. `withinRange` packages go to the
 * manager by name, which installs the highest version the range allows.
 * `beyondRange` maps each package moving past its range to its new version,
 * which must be written into the manifest first.
 */
export const splitUpdates = (
  results: UpdateResult[],
): {
  names: string[]
  withinRange: string[]
  beyondRange: Record<string, string>
} => {
  const names: string[] = []
  const withinRange: string[] = []
  const beyondRange: Record<string, string> = {}

  for (const { name, updated, target, wanted } of results) {
    if (!updated || !target) continue
    names.push(name)
    if (target === wanted) withinRange.push(name)
    else beyondRange[name] = target
  }

  return { names, withinRange, beyondRange }
}

export default filterPackages
