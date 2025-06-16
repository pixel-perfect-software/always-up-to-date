import semver from "semver"
import type { PackageInfo } from "@/types"
import logger from "./logger"
import { loadConfig } from "./config"

const config = loadConfig()

const updateChecker = ({ name, current, latest }: PackageInfo): boolean => {
  const allowMajorUpdates = config.allowMajorUpdates
  const allowMinorUpdates = config.allowMinorUpdates || allowMajorUpdates
  const updateAllowList = config.updateAllowlist
  const updateDenyList = config.updateDenylist

  // Validate version strings
  if (!semver.valid(current) || !semver.valid(latest)) {
    logger.error(
      `Invalid version format for ${name}: current=${current}, latest=${latest}`,
    )
    return false
  }

  if (updateAllowList.length > 0) {
    if (updateAllowList.includes(name)) return true
  }

  if (updateDenyList.length > 0) {
    if (updateDenyList.includes(name)) return false
  }

  // Check if there's actually an update available
  if (!semver.gt(latest, current)) return false

  // Determine the type of update
  const updateType = semver.diff(current, latest)

  switch (updateType) {
    case "patch":
      return true
    case "minor":
    case "preminor":
      if (allowMinorUpdates) return true
      break
    case "major":
    case "premajor":
      if (allowMajorUpdates) return true
      break
    case "prerelease":
      // eslint-disable-next-line no-case-declarations
      const baseUpdateType = semver.diff(
        semver.clean(current) || current,
        semver.clean(latest) || latest,
      )
      if (baseUpdateType === "patch") return true
      if (baseUpdateType === "minor" && allowMinorUpdates) return true
      if (baseUpdateType === "major" && allowMajorUpdates) return true
      break
  }

  logger.skippingPackage(name, current, latest, updateType)
  return false
}

export default updateChecker
