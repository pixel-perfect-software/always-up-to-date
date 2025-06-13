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
      packageJson.dependencies[packageName] =
        `^${outdatedPackages[packageName].latest}`
    }

    if (packageJson?.optionalDependencies?.[packageName]) {
      packageJson.optionalDependencies[packageName] =
        `^${outdatedPackages[packageName].latest}`
    }

    if (packageJson?.peerDependencies?.[packageName]) {
      packageJson.peerDependencies[packageName] =
        `^${outdatedPackages[packageName].latest}`
    }

    if (packageJson?.devDependencies?.[packageName]) {
      packageJson.devDependencies[packageName] =
        `^${outdatedPackages[packageName].latest}`
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
    // Check if the line contains a package to update
    const match = line.match(/^\s*\s*['"]?([^'"]+)['"]?\s*:/)
    if (match && packagesToUpdate.includes(match[1])) {
      const packageName = match[1]
      const latestVersion = outdatedPackages[packageName].latest
      // Update the version in the line
      return line.replace(/:\s*['"]?[^'"]+['"]?$/, `: '${latestVersion}'`)
    }

    // Return the line unchanged if no package to update is found
    return line
  })

  fs.writeFileSync(pnpmWorkspaceYamlPath, updatedLines.join("\n"), "utf8")
}
