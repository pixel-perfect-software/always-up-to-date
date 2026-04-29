import type { PackageInfo } from '@/types'
import { loadConfig } from './config'
import { isCooldownEnabled } from './cooldown'
import { MS_PER_DAY } from './duration'
import { loadRegistryConfig } from './npmrcLoader'
import { fetchReleaseTimes } from './registry'

/**
 * For each outdated package, compute how many days ago its `latest` version
 * was published. Returns an empty map when cooldown is disabled so that the
 * `check` command incurs no network cost in the default configuration.
 */
export const computeReleaseAges = async (
  outdated: Record<string, PackageInfo>,
  cwd: string,
  now: number = Date.now(),
): Promise<Record<string, number>> => {
  const config = loadConfig(cwd)
  if (!isCooldownEnabled(config.cooldown)) return {}

  const registryConfig = loadRegistryConfig(cwd)
  const ages: Record<string, number> = {}

  await Promise.all(
    Object.entries(outdated).map(async ([name, info]) => {
      const times = await fetchReleaseTimes(name, registryConfig)
      const releaseTime = times[info.latest]
      if (!releaseTime) return
      const ms = Date.parse(releaseTime)
      if (Number.isNaN(ms)) return
      ages[name] = (now - ms) / MS_PER_DAY
    }),
  )

  return ages
}
