import semver from "semver"
import type { PackageInfo } from "@/types"
import logger from "./logger"

const allowMajorUpdates = Boolean(process.env.ALLOW_MAJOR_UPDATES === "true")
const allowMinorUpdates =
  Boolean(process.env.ALLOW_MINOR_UPDATES === "true") || allowMajorUpdates

const updateChecker = ({ name, current, latest }: PackageInfo): boolean => {
  // Validate version strings
  if (!semver.valid(current) || !semver.valid(latest)) {
    logger.error(
      `Invalid version format for ${name}: current=${current}, latest=${latest}`,
    )
    return false
  }

  // Check if there's actually an update available
  if (!semver.gt(latest, current)) {
    return false
  }

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
