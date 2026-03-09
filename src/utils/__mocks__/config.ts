export const DEFAULT_CONFIG = {
  allowMinorUpdates: false,
  allowMajorUpdates: false,
  debug: false,
  silent: false,
  updateAllowlist: [] as string[],
  updateDenylist: [] as string[],
}

export const loadConfig = jest.fn().mockReturnValue({ ...DEFAULT_CONFIG })

export const saveJsonConfig = jest.fn()
