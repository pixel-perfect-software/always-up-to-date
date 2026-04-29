import fs from 'fs'
import path from 'path'
import type { AlwaysUpToDateConfig, CooldownConfig } from '@/types'
import { checkIfFileExists } from './files'

export const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/pixel-perfect-software/always-up-to-date/main/schema/config.schema.json'

const DEFAULT_CONFIG: AlwaysUpToDateConfig = {
  allowMinorUpdates: false,
  allowMajorUpdates: false,
  debug: false,
  silent: false,
  updateAllowlist: [],
  updateDenylist: [],
  cooldown: 0,
}

const isValidCooldownValue = (value: unknown): boolean => {
  if (typeof value === 'number') return Number.isFinite(value) && value >= 0
  return typeof value === 'string' && value.trim().length > 0
}

const parseCooldownInput = (input: unknown): CooldownConfig => {
  if (isValidCooldownValue(input)) return input as CooldownConfig
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>
    const sanitized: Partial<
      Record<'patch' | 'minor' | 'major', number | string>
    > = {}
    for (const key of ['patch', 'minor', 'major'] as const) {
      if (isValidCooldownValue(obj[key])) {
        sanitized[key] = obj[key] as number | string
      }
    }
    return sanitized
  }
  return DEFAULT_CONFIG.cooldown
}

/**
 * Load JSON configuration file
 */
const loadJsonConfig = (filePath: string): AlwaysUpToDateConfig => {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
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
      cooldown: parseCooldownInput(jsonConfig.cooldown),
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
  const jsonConfigPath = path.join(workingDir, '.always-up-to-date.json')

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
  config: AlwaysUpToDateConfig & { $schema?: string },
  filePath: string,
): void => {
  const jsonContent = JSON.stringify(config, null, 2)
  fs.writeFileSync(filePath, jsonContent, 'utf8')
}

export { DEFAULT_CONFIG }
