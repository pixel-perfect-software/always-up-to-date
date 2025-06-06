const { PackageManagerDetector } = require("../dist/utils/package-manager")
const path = require("path")

async function debugPackageManager() {
  const testPath = path.join(__dirname, "../test-monorepos/test-pnpm-catalog")

  console.log("🔍 Testing package manager outdated methods...\n")

  try {
    const packageManager = PackageManagerDetector.detect(testPath)
    console.log("Package manager type:", packageManager.constructor.name)

    // Test regular outdated check
    console.log("\n1. Testing checkOutdated():")
    try {
      const result = await packageManager.checkOutdated()
      console.log("✅ Success - Length:", result.length)
      console.log("First 300 chars:", result.substring(0, 300))

      // Try to parse as JSON
      try {
        const parsed = JSON.parse(result)
        console.log("✅ JSON parsing succeeded")
        console.log("Number of packages:", Object.keys(parsed).length)
      } catch (parseError) {
        console.log("❌ JSON parsing failed:", parseError.message)
        console.log(
          "Raw content (escaped):",
          JSON.stringify(result.substring(0, 500)),
        )
      }
    } catch (error) {
      console.log("❌ checkOutdated failed:", error.message)
      if (error.stdout) {
        console.log("Error stdout:", error.stdout.substring(0, 300))
      }
      if (error.stderr) {
        console.log("Error stderr:", error.stderr.substring(0, 300))
      }
    }

    // Test workspace outdated check
    console.log("\n2. Testing checkWorkspaceOutdated():")
    try {
      const result = await packageManager.checkWorkspaceOutdated()
      console.log("✅ Success - Length:", result.length)
      console.log("First 300 chars:", result.substring(0, 300))

      // Try to parse as JSON
      try {
        const parsed = JSON.parse(result)
        console.log("✅ JSON parsing succeeded")
        console.log("Number of packages:", Object.keys(parsed).length)
      } catch (parseError) {
        console.log("❌ JSON parsing failed:", parseError.message)
        console.log(
          "Raw content (escaped):",
          JSON.stringify(result.substring(0, 500)),
        )
      }
    } catch (error) {
      console.log("❌ checkWorkspaceOutdated failed:", error.message)
      if (error.stdout) {
        console.log("Error stdout:", error.stdout.substring(0, 300))

        // Try parsing the stdout
        try {
          const parsed = JSON.parse(error.stdout)
          console.log("✅ Error stdout JSON parsing succeeded")
          console.log("Number of packages:", Object.keys(parsed).length)
        } catch (parseError) {
          console.log(
            "❌ Error stdout JSON parsing failed:",
            parseError.message,
          )
          console.log(
            "Raw stdout (escaped):",
            JSON.stringify(error.stdout.substring(0, 500)),
          )
        }
      }
      if (error.stderr) {
        console.log("Error stderr:", error.stderr.substring(0, 300))
      }
    }
  } catch (error) {
    console.error("Error:", error.message)
  }
}

debugPackageManager().catch(console.error)
