import fs from 'fs'
import path from 'path'
import type {
  AlwaysUpToDateConfig,
  BeyondRange,
  ConfigFile,
  CooldownConfig,
  PackageRule,
} from '@/types'
import { checkIfFileExists } from './files'

export const CONFIG_SCHEMA_URL =
  'https://raw.githubusercontent.com/pixel-perfect-software/always-up-to-date/main/schema/config.schema.json'

const DEFAULT_CONFIG: AlwaysUpToDateConfig = {
  rules: {},
  allowMinorUpdates: false,
  allowMajorUpdates: false,
  debug: false,
  silent: false,
  updateAllowlist: [],
  updateDenylist: [],
  cooldown: 0,
}

/** The config file exists but cannot be used: malformed JSON or an invalid value. */
export class ConfigError extends Error {
  override name = 'ConfigError'
}

/** What `autd init` writes: the current shape, without the deprecated fields. */
const INITIAL_CONFIG: ConfigFile = {
  beyondRange: 'none',
  rules: {},
  cooldown: 0,
  debug: false,
  silent: false,
}

const BEYOND_RANGE_LEVELS: BeyondRange[] = ['none', 'patch', 'minor', 'major']
const PACKAGE_RULES: PackageRule[] = ['hold', 'followRange', 'latest']

const oneOf = (values: string[]) => values.map((v) => `"${v}"`).join(', ')

// Policy fields are validated strictly: silently ignoring a typo such as
// `"react": "hodl"` would update a package the user meant to hold.
const parseBeyondRange = (input: unknown): BeyondRange | undefined => {
  if (input === undefined) return undefined
  if (BEYOND_RANGE_LEVELS.includes(input as BeyondRange)) {
    return input as BeyondRange
  }
  throw new Error(
    `beyondRange must be one of ${oneOf(BEYOND_RANGE_LEVELS)} (got ${JSON.stringify(input)})`,
  )
}

const parseRules = (input: unknown): Record<string, PackageRule> => {
  if (input === undefined) return {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new Error('rules must be an object of package name to rule')
  }
  for (const [name, rule] of Object.entries(input)) {
    if (!PACKAGE_RULES.includes(rule as PackageRule)) {
      throw new Error(
        `rules[${JSON.stringify(name)}] must be one of ${oneOf(PACKAGE_RULES)} (got ${JSON.stringify(rule)})`,
      )
    }
  }
  return input as Record<string, PackageRule>
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
      beyondRange: parseBeyondRange(jsonConfig.beyondRange),
      rules: parseRules(jsonConfig.rules),
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
    const detail = error instanceof Error ? error.message : String(error)
    throw new ConfigError(
      `Failed to load JSON config from ${filePath}: ${detail}`,
      { cause: error },
    )
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
export const saveJsonConfig = (config: ConfigFile, filePath: string): void => {
  const jsonContent = JSON.stringify(config, null, 2)
  fs.writeFileSync(filePath, jsonContent, 'utf8')
}

export { DEFAULT_CONFIG, INITIAL_CONFIG }
