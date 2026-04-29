import type { ReleaseType } from 'semver'

export type SupportedPackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun'

export interface PackageInfo {
  name: string
  current: string
  latest: string
}

export interface UpdateResult {
  name: string
  current: string
  latest: string
  updateType: ReleaseType | null
  updated: boolean
  reason?: string
  releaseAge?: number
}

export type CooldownValue = number | string

export interface CooldownByType {
  patch?: CooldownValue
  minor?: CooldownValue
  major?: CooldownValue
}

export type CooldownConfig = CooldownValue | CooldownByType

export interface AlwaysUpToDateConfig {
  allowMinorUpdates: boolean
  allowMajorUpdates: boolean
  debug: boolean
  silent: boolean
  updateAllowlist: string[]
  updateDenylist: string[]
  cooldown: CooldownConfig
}

export interface RegistryConfig {
  registry: string
  scopedRegistries: Record<string, string>
  authTokens: Record<string, string>
  alwaysAuth?: boolean
  strictSSL?: boolean
  ca?: string | string[]
  cafile?: string
}
