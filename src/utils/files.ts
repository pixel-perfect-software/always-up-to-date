import type { PackageInfo } from "@/types"
import fs from "fs"

export const checkIfFileExists = (filePath: string): boolean => {
  try {
    // Check if the file exists
    const stats = fs.statSync(filePath)
    // Return true if it is a file
    if (stats.isFile()) return true

    // If it exists but is not a file, return false
    return false
  } catch {
    return false
  }
}

const isWorkspaceReference = (version: string): boolean => {
  return (
    version.startsWith("catalog:") ||
    version.startsWith("workspace:") ||
    version === "workspace:*"
  )
}

/**
 * Extracts the version decorator from a version string (^, ~, >=, etc.)
 * and returns it along with the clean version number
 */
const parseVersionString = (
  versionString: string,
): { decorator: string; version: string } => {
  // Handle workspace and catalog references
  if (isWorkspaceReference(versionString)) {
    return { decorator: "", version: versionString }
  }

  // Match common version decorators: ^, ~, >=, >, <=, <, =
  const match = versionString.match(/^([~^>=<!]*)(.+)$/)

  if (match) {
    return {
      decorator: match[1] || "",
      version: match[2],
    }
  }

  // Fallback: no decorator found
  return { decorator: "", version: versionString }
}

/**
 * Applies the preserved decorator to a new version
 */
const applyVersionDecorator = (
  decorator: string,
  newVersion: string,
): string => (decorator ? `${decorator}${newVersion}` : newVersion)

export const updatePackageJson = async (
  cwd: string,
  packagesToUpdate: string[],
  outdatedPackages: Record<string, PackageInfo>,
): Promise<void> => {
  const packageJsonPath = `${cwd}/package.json`
  const packageJsonContent = fs.readFileSync(packageJsonPath, "utf8")

  const packageJson = JSON.parse(packageJsonContent)

  // Update the version of each package in the package.json
  packagesToUpdate.forEach((packageName) => {
    if (packageJson?.dependencies?.[packageName]) {
      const currentVersion = packageJson.dependencies[packageName]
      if (!isWorkspaceReference(currentVersion)) {
        const { decorator } = parseVersionString(currentVersion)
        const newVersion = applyVersionDecorator(
          decorator || "^", // Default to ^ if no decorator found
          outdatedPackages[packageName].latest,
        )
        packageJson.dependencies[packageName] = newVersion
      }
    }

    if (packageJson?.optionalDependencies?.[packageName]) {
      const currentVersion = packageJson.optionalDependencies[packageName]
      if (!isWorkspaceReference(currentVersion)) {
        const { decorator } = parseVersionString(currentVersion)
        const newVersion = applyVersionDecorator(
          decorator || "^", // Default to ^ if no decorator found
          outdatedPackages[packageName].latest,
        )
        packageJson.optionalDependencies[packageName] = newVersion
      }
    }

    if (packageJson?.peerDependencies?.[packageName]) {
      const currentVersion = packageJson.peerDependencies[packageName]
      if (!isWorkspaceReference(currentVersion)) {
        const { decorator } = parseVersionString(currentVersion)
        const newVersion = applyVersionDecorator(
          decorator || "^", // Default to ^ if no decorator found
          outdatedPackages[packageName].latest,
        )
        packageJson.peerDependencies[packageName] = newVersion
      }
    }

    if (packageJson?.devDependencies?.[packageName]) {
      const currentVersion = packageJson.devDependencies[packageName]
      if (!isWorkspaceReference(currentVersion)) {
        const { decorator } = parseVersionString(currentVersion)
        const newVersion = applyVersionDecorator(
          decorator || "^", // Default to ^ if no decorator found
          outdatedPackages[packageName].latest,
        )
        packageJson.devDependencies[packageName] = newVersion
      }
    }
  })

  fs.writeFileSync(
    packageJsonPath,
    JSON.stringify(packageJson, null, 2),
    "utf8",
  )
}

export const updatePNPMWorkspaceYAML = async (
  cwd: string,
  packagesToUpdate: string[],
  outdatedPackages: Record<string, PackageInfo>,
): Promise<void> => {
  const pnpmWorkspaceYamlPath = `${cwd}/pnpm-workspace.yaml`
  const pnpmWorkspaceYamlContent = fs.readFileSync(
    pnpmWorkspaceYamlPath,
    "utf8",
  )

  const lines = pnpmWorkspaceYamlContent.split("\n")

  const updatedLines = lines.map((line) => {
    const match = line.match(
      /^\s*\s*['"]?([^'"]+)['"]?\s*:\s*['"]?([^'"]+)['"]?/,
    )

    if (match && packagesToUpdate.includes(match[1])) {
      const packageName = match[1]
      const currentVersion = match[2]
      const latestVersion = outdatedPackages[packageName].latest

      // Parse the current version to preserve the decorator
      const { decorator } = parseVersionString(currentVersion)
      const newVersion = applyVersionDecorator(
        decorator || "^", // Default to ^ if no decorator found
        latestVersion,
      )

      // Update the version in the line, preserving quotes if they exist
      const hasQuotes =
        line.includes(`"${currentVersion}"`) ||
        line.includes(`'${currentVersion}'`)
      const versionToInsert = hasQuotes ? `'${newVersion}'` : newVersion

      return line.replace(/:\s*['"]?[^'"]+['"]?$/, `: ${versionToInsert}`)
    }

    // Return the line unchanged if no package to update is found
    return line
  })

  fs.writeFileSync(pnpmWorkspaceYamlPath, updatedLines.join("\n"), "utf8")
}

export const updateBunCatalogs = async (
  cwd: string,
  packagesToUpdate: string[],
  outdatedPackages: Record<string, PackageInfo>,
): Promise<void> => {
  const packageJsonPath = `${cwd}/package.json`
  const packageJsonContent = fs.readFileSync(packageJsonPath, "utf8")
  const packageJson = JSON.parse(packageJsonContent)

  let catalogsUpdated = false

  // Handle the default "catalog" field (singular)
  if (packageJson.catalog && typeof packageJson.catalog === "object") {
    for (const packageName of packagesToUpdate) {
      if (packageJson.catalog[packageName]) {
        const currentVersion = packageJson.catalog[packageName]
        const latestVersion = outdatedPackages[packageName].latest

        // Parse version decorator (^, ~, >=, etc.)
        const { decorator } = parseVersionString(currentVersion)
        const newVersion = applyVersionDecorator(
          decorator || "^", // Default to ^ if no decorator found
          latestVersion,
        )

        // Update the catalog entry
        packageJson.catalog[packageName] = newVersion
        catalogsUpdated = true
      }
    }
  }

  // Handle named catalogs (plural)
  if (packageJson.catalogs && typeof packageJson.catalogs === "object") {
    // Iterate through each catalog (e.g., "repo", "types", "ui")
    for (const catalogName of Object.keys(packageJson.catalogs)) {
      const catalog = packageJson.catalogs[catalogName]

      if (!catalog || typeof catalog !== "object") {
        continue
      }

      // Update packages in this catalog
      for (const packageName of packagesToUpdate) {
        if (catalog[packageName]) {
          const currentVersion = catalog[packageName]
          const latestVersion = outdatedPackages[packageName].latest

          // Parse version decorator (^, ~, >=, etc.)
          const { decorator } = parseVersionString(currentVersion)
          const newVersion = applyVersionDecorator(
            decorator || "^", // Default to ^ if no decorator found
            latestVersion,
          )

          // Update the catalog entry
          packageJson.catalogs[catalogName][packageName] = newVersion
          catalogsUpdated = true
        }
      }
    }
  }

  // Only write if something was updated
  if (catalogsUpdated) {
    fs.writeFileSync(
      packageJsonPath,
      JSON.stringify(packageJson, null, 2),
      "utf8",
    )
  }
}

export const identifyCatalogPackages = (
  cwd: string,
  outdatedPackages: Record<string, PackageInfo>,
): { catalogPackages: string[]; rootPackages: string[] } => {
  const packageJsonPath = `${cwd}/package.json`
  const packageJsonContent = fs.readFileSync(packageJsonPath, "utf8")
  const packageJson = JSON.parse(packageJsonContent)

  const catalogPackages: string[] = []
  const rootPackages: string[] = []

  // Build a set of all packages defined in catalogs
  const catalogDefinedPackages = new Set<string>()

  // Check the default "catalog" field (singular)
  if (packageJson.catalog && typeof packageJson.catalog === "object") {
    Object.keys(packageJson.catalog).forEach((pkg) =>
      catalogDefinedPackages.add(pkg),
    )
  }

  // Check named catalogs (plural)
  if (packageJson.catalogs && typeof packageJson.catalogs === "object") {
    for (const catalogName of Object.keys(packageJson.catalogs)) {
      const catalog = packageJson.catalogs[catalogName]
      if (catalog && typeof catalog === "object") {
        Object.keys(catalog).forEach((pkg) => catalogDefinedPackages.add(pkg))
      }
    }
  }

  // Categorize outdated packages
  for (const packageName of Object.keys(outdatedPackages)) {
    if (catalogDefinedPackages.has(packageName)) {
      catalogPackages.push(packageName)
    } else {
      rootPackages.push(packageName)
    }
  }

  return { catalogPackages, rootPackages }
}
