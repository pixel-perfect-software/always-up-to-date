import fs from 'fs'
import path from 'path'
import type {
  AlwaysUpToDateConfig,
  BeyondRange,
  ConfigFile,
  CooldownConfig,
  PackageRule,
} from '@/types'
import { readDuration } from './duration'
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
  depsDev: true,
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

type CooldownType = 'patch' | 'minor' | 'major'
const COOLDOWN_TYPES: CooldownType[] = ['patch', 'minor', 'major']

const cooldownDays = (key: string, value: unknown): number | string => {
  if (
    (typeof value === 'number' || typeof value === 'string') &&
    readDuration(value) !== undefined
  ) {
    return value
  }
  throw new Error(
    `${key} must be a number of days or a duration like "1 week" (got ${JSON.stringify(value)})`,
  )
}

// A typo must not turn the cooldown off: "30 dyas" is an error, not 0 days.
const parseCooldownInput = (input: unknown): CooldownConfig => {
  if (input === undefined) return DEFAULT_CONFIG.cooldown
  if (input && typeof input === 'object' && !Array.isArray(input)) {
    const obj = input as Record<string, unknown>
    for (const key of Object.keys(obj)) {
      if (!COOLDOWN_TYPES.includes(key as CooldownType)) {
        throw new Error(
          `cooldown has an unknown key ${JSON.stringify(key)}; use ${oneOf(COOLDOWN_TYPES)}`,
        )
      }
    }
    const parsed: Partial<Record<CooldownType, number | string>> = {}
    for (const key of COOLDOWN_TYPES) {
      if (obj[key] !== undefined) {
        parsed[key] = cooldownDays(`cooldown.${key}`, obj[key])
      }
    }
    return parsed
  }
  return cooldownDays('cooldown', input)
}

const parseBoolean = (key: string, input: unknown, fallback: boolean) => {
  if (input === undefined) return fallback
  if (typeof input === 'boolean') return input
  throw new Error(`${key} must be true or false (got ${JSON.stringify(input)})`)
}

// A privacy switch must not fail open: Boolean("false") is true.
const parseDepsDev = (input: unknown): boolean =>
  parseBoolean('depsDev', input, DEFAULT_CONFIG.depsDev)

const KNOWN_KEYS = [
  '$schema',
  'beyondRange',
  'rules',
  'allowMinorUpdates',
  'allowMajorUpdates',
  'debug',
  'silent',
  'updateAllowlist',
  'updateDenylist',
  'cooldown',
  'depsDev',
]

const editDistance = (a: string, b: string): number => {
  let row = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const next = [i]
    for (let j = 1; j <= b.length; j++) {
      next[j] = Math.min(
        row[j] + 1,
        next[j - 1] + 1,
        row[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      )
    }
    row = next
  }
  return row[b.length]
}

/** The known key a misspelling is closest to, when it is within two edits (case ignored). */
const nearestKey = (key: string): string | undefined => {
  const lower = key.toLowerCase()
  let best: { key: string; distance: number } | undefined
  for (const known of KNOWN_KEYS) {
    const distance = editDistance(lower, known.toLowerCase())
    if (distance <= 2 && (!best || distance < best.distance)) {
      best = { key: known, distance }
    }
  }
  return best?.key
}

const unknownKeyWarnings = (
  config: Record<string, unknown>,
  filePath: string,
): string[] =>
  Object.keys(config)
    .filter((key) => !KNOWN_KEYS.includes(key))
    .map((key) => {
      const near = nearestKey(key)
      return `Ignoring unknown key ${JSON.stringify(key)} in ${filePath}${near ? ` (did you mean ${JSON.stringify(near)}?)` : ''}`
    })

/**
 * Load JSON configuration file
 */
const loadJsonConfig = (
  filePath: string,
  onWarning?: (message: string) => void,
): AlwaysUpToDateConfig => {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    const jsonConfig: unknown = JSON.parse(content)
    if (
      !jsonConfig ||
      typeof jsonConfig !== 'object' ||
      Array.isArray(jsonConfig)
    ) {
      throw new Error('the file must hold a JSON object')
    }
    const fields = jsonConfig as Record<string, unknown>

    // Validate and merge with defaults
    const config: AlwaysUpToDateConfig = {
      beyondRange: parseBeyondRange(fields.beyondRange),
      rules: parseRules(fields.rules),
      allowMinorUpdates: parseBoolean(
        'allowMinorUpdates',
        fields.allowMinorUpdates,
        DEFAULT_CONFIG.allowMinorUpdates,
      ),
      allowMajorUpdates: parseBoolean(
        'allowMajorUpdates',
        fields.allowMajorUpdates,
        DEFAULT_CONFIG.allowMajorUpdates,
      ),
      debug: parseBoolean('debug', fields.debug, DEFAULT_CONFIG.debug),
      silent: parseBoolean('silent', fields.silent, DEFAULT_CONFIG.silent),
      updateAllowlist: Array.isArray(fields.updateAllowlist)
        ? fields.updateAllowlist
        : DEFAULT_CONFIG.updateAllowlist,
      updateDenylist: Array.isArray(fields.updateDenylist)
        ? fields.updateDenylist
        : DEFAULT_CONFIG.updateDenylist,
      cooldown: parseCooldownInput(fields.cooldown),
      depsDev: parseDepsDev(fields.depsDev),
    }
    for (const warning of unknownKeyWarnings(fields, filePath)) {
      onWarning?.(warning)
    }
    return config
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ConfigError(
      `Failed to load JSON config from ${filePath}: ${detail}`,
      { cause: error },
    )
  }
}

const CONFIG_FILE = '.always-up-to-date.json'

/**
 * The config file a run uses: the working directory's own, else
 * `fallbackDir`'s (a workspace root, for a member run, #123). Undefined when
 * neither has one. No per-key merge.
 */
export const configFileFor = (
  workingDir: string,
  fallbackDir?: string,
): string | undefined =>
  [workingDir, fallbackDir]
    .filter((dir): dir is string => dir !== undefined)
    .map((dir) => path.join(dir, CONFIG_FILE))
    .find((file) => checkIfFileExists(file))

/**
 * Load configuration from the working directory, else from `fallbackDir`.
 * Only supports JSON format. A file that holds anything but an object, or an
 * invalid value, throws `ConfigError`; an unknown key goes to `onWarning`,
 * since the caller configures the logger after loading (`openProject`).
 */
export const loadConfig = (
  workingDir: string = process.cwd(),
  fallbackDir?: string,
  onWarning?: (message: string) => void,
): AlwaysUpToDateConfig => {
  const jsonConfigPath = configFileFor(workingDir, fallbackDir)

  if (jsonConfigPath) {
    return loadJsonConfig(jsonConfigPath, onWarning)
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
