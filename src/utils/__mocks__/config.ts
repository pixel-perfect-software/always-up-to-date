import { fn, requireActual } from 'provino'
export const CONFIG_SCHEMA_URL =
  'https://example.test/schema/config.schema.json'

export const DEFAULT_CONFIG = {
  rules: {},
  allowMinorUpdates: false,
  allowMajorUpdates: false,
  debug: false,
  silent: false,
  updateAllowlist: [] as string[],
  updateDenylist: [] as string[],
  cooldown: 0,
}

// The real value: tests assert on what `autd init` actually writes.
export const INITIAL_CONFIG = requireActual('../config').INITIAL_CONFIG

export const loadConfig = fn().mockReturnValue({ ...DEFAULT_CONFIG })

export const saveJsonConfig = fn()

export const configFileFor = fn()
