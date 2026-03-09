import semver from 'semver'
import type { PackageInfo, UpdateResult } from '@/types'
import updateChecker from './updateChecker'

/**
 * Filters outdated packages through the update checker and returns structured results.
 * Optionally scopes to a specific set of package names.
 */
const filterPackages = (
  outdatedPackages: Record<string, PackageInfo>,
  targetPackages?: string[],
): UpdateResult[] => {
  return Object.entries(outdatedPackages).map(([name, packageInfo]) => {
    const updateType = semver.diff(packageInfo.current, packageInfo.latest)

    // If targeting specific packages, skip anything not in the list
    if (targetPackages && targetPackages.length > 0) {
      if (!targetPackages.includes(name)) {
        return {
          name,
          current: packageInfo.current,
          latest: packageInfo.latest,
          updateType,
          updated: false,
          reason: 'not targeted',
        }
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
  })
}

export default filterPackages
