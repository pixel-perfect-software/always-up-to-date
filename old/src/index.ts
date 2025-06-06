// Export utilities and services for programmatic use
export { default as NpmWrapper } from "./utils/npm-wrapper"
export { PackageManagerDetector } from "./utils/package-manager"
export { ConfigManager } from "./utils/config"
export { logger } from "./utils/logger"

// Export command functions for programmatic use
export { checkDependencies } from "./commands/check"
export { auditDependencies } from "./commands/audit"
export { autoUpdateDependencies } from "./commands/auto"
export { showDependencyDiff } from "./commands/diff"
export { rollbackDependencies } from "./commands/rollback"

// Export types for TypeScript users
export type * from "./types"

// Export the main CLI runner
import { run } from "./cli"

// Main entry point for the application
const main = async () => {
  try {
    await run()
  } catch (error) {
    console.error("An error occurred:", error)
    process.exit(1)
  }
}

// Execute if run directly
if (require.main === module) {
  main()
}

// Export for use as a library
export { run, main }
