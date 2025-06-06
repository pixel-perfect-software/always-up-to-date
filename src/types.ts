export type SupportedPackageManager = "npm" | "yarn" | "pnpm" | "bun"

export interface PackageInfo {
  current: string
  latest: string
}
