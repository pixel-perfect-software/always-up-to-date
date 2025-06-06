const { WorkspaceManager } = require("../dist/utils/workspace-manager");
const path = require("path");

async function testCatalogParsing() {
  const testPath = path.join(__dirname, "../test-monorepos/test-pnpm-catalog");

  try {
    const workspaceInfo = await WorkspaceManager.detect(testPath);

    console.log("Workspace Info:");
    console.log("- Is Monorepo:", workspaceInfo.isMonorepo);
    console.log("- Package Manager:", workspaceInfo.packageManager);
    console.log("- Packages:", workspaceInfo.packages.length);

    if (workspaceInfo.catalog) {
      console.log("\nCatalog Entries:");
      for (const [pkg, version] of Object.entries(workspaceInfo.catalog)) {
        console.log(`  ${pkg}: ${version}`);
      }
    } else {
      console.log("\nNo catalog found");
    }
  } catch (error) {
    console.error("Error:", error.message);
  }
}

testCatalogParsing();
