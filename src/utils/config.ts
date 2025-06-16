import fs from "fs"
import path from "path"
import type { AlwaysUpToDateConfig } from "@/types"
import { checkIfFileExists } from "./files"

const DEFAULT_CONFIG: AlwaysUpToDateConfig = {
  allowMinorUpdates: false,
  allowMajorUpdates: false,
  debug: false,
  silent: false,
  updateAllowlist: [],
  updateDenylist: [],
}

/**
 * Load JSON configuration file
 */
const loadJsonConfig = (filePath: string): AlwaysUpToDateConfig => {
  try {
    const content = fs.readFileSync(filePath, "utf8")
    const jsonConfig = JSON.parse(content)

    // Validate and merge with defaults
    return {
      allowMinorUpdates: Boolean(
        jsonConfig.allowMinorUpdates ?? DEFAULT_CONFIG.allowMinorUpdates,
      ),
      allowMajorUpdates: Boolean(
        jsonConfig.allowMajorUpdates ?? DEFAULT_CONFIG.allowMajorUpdates,
      ),
      debug: Boolean(jsonConfig.debug ?? DEFAULT_CONFIG.debug),
      silent: Boolean(jsonConfig.silent ?? DEFAULT_CONFIG.silent),
      updateAllowlist: Array.isArray(jsonConfig.updateAllowlist)
        ? jsonConfig.updateAllowlist
        : DEFAULT_CONFIG.updateAllowlist,
      updateDenylist: Array.isArray(jsonConfig.updateDenylist)
        ? jsonConfig.updateDenylist
        : DEFAULT_CONFIG.updateDenylist,
    }
  } catch (error) {
    throw new Error(`Failed to load JSON config from ${filePath}: ${error}`)
  }
}

/**
 * Load configuration from the working directory
 * Only supports JSON format
 */
export const loadConfig = (
  workingDir: string = process.cwd(),
): AlwaysUpToDateConfig => {
  const jsonConfigPath = path.join(workingDir, ".always-up-to-date.json")

  if (checkIfFileExists(jsonConfigPath)) {
    return loadJsonConfig(jsonConfigPath)
  }

  // Return default config if no file exists
  return DEFAULT_CONFIG
}

/**
 * Save configuration to JSON format
 */
export const saveJsonConfig = (
  config: AlwaysUpToDateConfig,
  filePath: string,
): void => {
  const jsonContent = JSON.stringify(config, null, 2)
  fs.writeFileSync(filePath, jsonContent, "utf8")
}

export { DEFAULT_CONFIG }
