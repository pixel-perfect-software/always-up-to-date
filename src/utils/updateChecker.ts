import type { PackageInfo } from "@/types"
import logger from "./logger"

const allowMajorUpdates = false
const allowMinorUpdates = false

const isMajorUpdate = (current: string, latest: string): boolean => {
  const currentParts = current.split(".")
  const latestParts = latest.split(".")
  if (currentParts.length !== latestParts.length) {
    return false // Different version formats
  }
  // Compare major version numbers
  return parseInt(latestParts[0], 10) > parseInt(currentParts[0], 10)
}

const isMinorUpdate = (current: string, latest: string): boolean => {
  const currentParts = current.split(".")
  const latestParts = latest.split(".")
  if (currentParts.length !== latestParts.length) {
    return false // Different version formats
  }
  // Compare major and minor version numbers
  return (
    parseInt(latestParts[0], 10) === parseInt(currentParts[0], 10) &&
    parseInt(latestParts[1], 10) > parseInt(currentParts[1], 10)
  )
}

const isPatchUpdate = (current: string, latest: string): boolean => {
  const currentParts = current.split(".")
  const latestParts = latest.split(".")
  if (currentParts.length !== latestParts.length) {
    return false // Different version formats
  }

  // Compare major, minor, and patch version numbers
  return (
    parseInt(latestParts[0], 10) === parseInt(currentParts[0], 10) &&
    parseInt(latestParts[1], 10) === parseInt(currentParts[1], 10) &&
    parseInt(latestParts[2], 10) > parseInt(currentParts[2], 10)
  )
}

const updateChecker = ({ name, current, latest }: PackageInfo): boolean => {
  if (isPatchUpdate(current, latest)) return true
  if (isMinorUpdate(current, latest) && allowMinorUpdates) return true
  if (isMajorUpdate(current, latest) && allowMajorUpdates) return true

  logger.skippingPackage(
    name,
    current,
    latest,
    isMajorUpdate(current, latest)
      ? "major"
      : isMinorUpdate(current, latest)
        ? "minor"
        : "patch",
  )

  return false
}

export default updateChecker
