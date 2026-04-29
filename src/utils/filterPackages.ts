import semver from 'semver'
import type { PackageInfo, UpdateResult } from '@/types'
import { loadConfig } from './config'
import { evaluateCooldown, isCooldownEnabled } from './cooldown'
import { formatAgeDays } from './duration'
import { loadRegistryConfig } from './npmrcLoader'
import { fetchReleaseTimes } from './registry'
import updateChecker from './updateChecker'

interface FilterPackagesOptions {
  targetPackages?: string[]
  cwd?: string
  now?: number
}

/**
 * Filters outdated packages through semver checks, allow/denylists, and the
 * cooldown gate (when enabled). Network calls only happen for packages that
 * pass semver — no-op when `cooldown` is 0 (the default).
 */
const filterPackages = async (
  outdatedPackages: Record<string, PackageInfo>,
  options: FilterPackagesOptions = {},
): Promise<UpdateResult[]> => {
  const { targetPackages, cwd = process.cwd(), now } = options
  const config = loadConfig(cwd)
  const cooldownActive = isCooldownEnabled(config.cooldown)
  const registryConfig = cooldownActive ? loadRegistryConfig(cwd) : undefined

  const initialResults: UpdateResult[] = Object.entries(outdatedPackages).map(
    ([name, packageInfo]) => {
      const updateType = semver.diff(packageInfo.current, packageInfo.latest)

      if (
        targetPackages &&
        targetPackages.length > 0 &&
        !targetPackages.includes(name)
      ) {
        return {
          name,
          current: packageInfo.current,
          latest: packageInfo.latest,
          updateType,
          updated: false,
          reason: 'not targeted',
        }
      }

      const shouldUpdate = updateChecker({
        name,
        current: packageInfo.current,
        latest: packageInfo.latest,
      })

      return {
        name,
        current: packageInfo.current,
        latest: packageInfo.latest,
        updateType,
        updated: shouldUpdate,
        reason: shouldUpdate ? undefined : 'skipped by config',
      }
    },
  )

  if (!cooldownActive || !registryConfig) return initialResults

  return Promise.all(
    initialResults.map(async (result) => {
      if (!result.updated) return result

      const releaseTimes = await fetchReleaseTimes(result.name, registryConfig)
      const releaseTime = releaseTimes[result.latest]
      const evaluation = evaluateCooldown(
        releaseTime,
        result.updateType,
        config.cooldown,
        now,
      )

      if (evaluation.gated) {
        return {
          ...result,
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

export default filterPackages
