export type SupportedPackageManager = "npm" | "yarn" | "pnpm" | "bun"

export interface PackageInfo {
  name: string
  current: string
  latest: string
}
