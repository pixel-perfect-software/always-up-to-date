const { WorkspaceManager } = require("../dist/utils/workspace-manager")
const { CatalogResolver } = require("../dist/utils/catalog-resolver")
const { BulkProcessor } = require("../dist/services/bulk-processor")
const { PackageManagerDetector } = require("../dist/utils/package-manager")
const path = require("path")

async function debugCatalogUpdates() {
  const testPath = path.join(__dirname, "../test-monorepos/test-pnpm-catalog")

  try {
    console.log("🔍 Starting catalog update debugging...\n")

    // 1. Check workspace detection
    console.log("1. Workspace Detection:")
    const workspaceInfo = await WorkspaceManager.detect(testPath)
    console.log("- Is Monorepo:", workspaceInfo.isMonorepo)
    console.log("- Package Manager:", workspaceInfo.packageManager)
    console.log("- Packages:", workspaceInfo.packages.length)
    console.log("- Has Catalog:", !!workspaceInfo.catalog)

    if (workspaceInfo.catalog) {
      console.log("\n2. Catalog Entries:")
      for (const [pkg, version] of Object.entries(workspaceInfo.catalog)) {
        console.log(`  ${pkg}: ${version}`)
      }
    }

    // 2. Check dependency resolution
    console.log("\n3. Dependency Resolution:")
    const catalogDeps = CatalogResolver.getCatalogDependencies(workspaceInfo)
    console.log("Catalog dependencies found:", catalogDeps.size)
    for (const [pkg, workspaces] of catalogDeps.entries()) {
      console.log(`  ${pkg}: used in ${Array.from(workspaces).join(", ")}`)

      // Check if should update catalog
      const shouldUpdateCatalog = CatalogResolver.shouldUpdateCatalog(
        pkg,
        workspaceInfo,
      )
      console.log(`    Should update catalog: ${shouldUpdateCatalog}`)

      // Resolve dependency version
      const resolved = CatalogResolver.resolveDependencyVersion(
        pkg,
        workspaceInfo,
      )
      if (resolved) {
        console.log(
          `    Resolved: ${resolved.version} (source: ${resolved.source})`,
        )
      }
    }

    // 3. Check bulk processing
    console.log("\n4. Bulk Processing:")
    const packageManager = PackageManagerDetector.detect(testPath)
    const bulkProcessor = new BulkProcessor(packageManager, workspaceInfo)

    console.log("Getting bulk dependency info...")
    const bulkDependencyInfo = await bulkProcessor.processBulkDependencies()

    console.log(
      `Found ${bulkDependencyInfo.size} dependencies in bulk processing:`,
    )
    for (const [pkg, info] of bulkDependencyInfo.entries()) {
      console.log(`  ${pkg}:`)
      console.log(
        `    Current versions: ${Array.from(info.currentVersions).join(", ")}`,
      )
      console.log(`    Latest version: ${info.latestVersion || "NOT FOUND"}`)
      console.log(`    Has breaking changes: ${info.hasBreakingChanges}`)

      // Check if this is a catalog dependency
      const isCatalogDep = catalogDeps.has(pkg)
      console.log(`    Is catalog dependency: ${isCatalogDep}`)

      if (isCatalogDep && workspaceInfo.catalog) {
        const catalogVersion = workspaceInfo.catalog[pkg]
        console.log(`    Catalog version: ${catalogVersion}`)
        console.log(
          `    Latest vs Catalog: ${info.latestVersion} vs ${catalogVersion}`,
        )
      }
    }

    // 4. Manual version checks
    console.log("\n5. Manual Version Checks:")
    const testPackages = ["react", "typescript", "@types/node", "eslint"]

    for (const pkg of testPackages) {
      try {
        const { execSync } = require("child_process")
        const latestVersion = execSync(`npm show ${pkg} version`, {
          stdio: "pipe",
        })
          .toString()
          .trim()
        const catalogVersion = workspaceInfo.catalog?.[pkg]

        console.log(`  ${pkg}:`)
        console.log(`    Catalog: ${catalogVersion}`)
        console.log(`    Latest: ${latestVersion}`)

        if (catalogVersion && latestVersion) {
          const semver = require("semver")
          const catalogClean = catalogVersion.replace(/[\^~>=<]/g, "")
          const needsUpdate = semver.lt(catalogClean, latestVersion)
          console.log(
            `    Needs update: ${needsUpdate} (${catalogClean} < ${latestVersion})`,
          )
        }
      } catch (error) {
        console.log(`    Error checking ${pkg}: ${error.message}`)
      }
    }
  } catch (error) {
    console.error("Error:", error.message)
    console.error(error.stack)
  }
}

debugCatalogUpdates()
