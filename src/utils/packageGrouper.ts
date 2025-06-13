import type { PackageInfo } from "@/types"

export interface GroupedPackages {
  [groupName: string]: Array<{
    name: string
    info: PackageInfo
  }>
}

/**
 * Groups and sorts packages by namespace for better readability
 */
export function groupAndSortPackages(
  packages: Record<string, PackageInfo>,
): GroupedPackages {
  const grouped: GroupedPackages = {}

  // Process each package
  Object.entries(packages).forEach(([packageName, packageInfo]) => {
    let groupName: string

    if (packageName.startsWith("@")) {
      // Extract scope from scoped package (e.g., @babel/core -> @babel)
      const scopeMatch = packageName.match(/^(@[^/]+)/)
      groupName = scopeMatch ? scopeMatch[1] : "unscoped"
    } else groupName = "unscoped"

    if (!grouped[groupName]) grouped[groupName] = []

    grouped[groupName].push({ name: packageName, info: packageInfo })
  })

  // Sort packages within each group alphabetically
  Object.keys(grouped).forEach((groupName) => {
    grouped[groupName].sort((a, b) => a.name.localeCompare(b.name))
  })

  return grouped
}

/**
 * Gets sorted group names with unscoped packages last
 */
export function getSortedGroupNames(
  groupedPackages: GroupedPackages,
): string[] {
  const groupNames = Object.keys(groupedPackages)
  const scopedGroups = groupNames.filter((name) => name !== "unscoped").sort()
  const unscopedGroup = groupNames.includes("unscoped") ? ["unscoped"] : []

  return [...scopedGroups, ...unscopedGroup]
}
