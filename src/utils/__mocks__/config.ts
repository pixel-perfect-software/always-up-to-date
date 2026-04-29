export const CONFIG_SCHEMA_URL =
  'https://example.test/schema/config.schema.json'

export const DEFAULT_CONFIG = {
  allowMinorUpdates: false,
  allowMajorUpdates: false,
  debug: false,
  silent: false,
  updateAllowlist: [] as string[],
  updateDenylist: [] as string[],
  cooldown: 0,
}

export const loadConfig = jest.fn().mockReturnValue({ ...DEFAULT_CONFIG })

export const saveJsonConfig = jest.fn()
