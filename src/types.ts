export type SupportedPackageManager = "npm" | "yarn" | "pnpm" | "bun"

export interface PackageInfo {
  name: string
  current: string
  latest: string
}

export interface AlwaysUpToDateConfig {
  allowMinorUpdates: boolean
  allowMajorUpdates: boolean
  debug: boolean
  silent: boolean
  updateAllowlist: string[]
  updateDenylist: string[]
}
