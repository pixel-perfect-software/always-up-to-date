import type { ReleaseType } from 'semver'

export type SupportedPackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun'

export interface PackageInfo {
  name: string
  current: string
  /** Highest version the manifest range allows: what the manager would install. */
  wanted: string
  latest: string
}

export interface UpdateResult {
  name: string
  current: string
  wanted: string
  latest: string
  /** Version the update moves to, when `updated`. Equal to `wanted` when it stays within the range. */
  target?: string
  updateType: ReleaseType | null
  updated: boolean
  reason?: string
  releaseAge?: number
}

/** How far past its manifest range a package may move. */
export type BeyondRange = 'none' | 'patch' | 'minor' | 'major'

/** Per-package override: never, within range only, or always latest. */
export type PackageRule = 'hold' | 'followRange' | 'latest'

export type CooldownValue = number | string

export interface CooldownByType {
  patch?: CooldownValue
  minor?: CooldownValue
  major?: CooldownValue
}

export type CooldownConfig = CooldownValue | CooldownByType

export interface AlwaysUpToDateConfig {
  /** How far past its range a package may move. Unset: the legacy fields decide. */
  beyondRange?: BeyondRange
  /** Per-package overrides, keyed by exact name or `*` glob. */
  rules: Record<string, PackageRule>
  /** @deprecated Use `beyondRange: "minor"`. */
  allowMinorUpdates: boolean
  /** @deprecated Use `beyondRange: "major"`. */
  allowMajorUpdates: boolean
  debug: boolean
  silent: boolean
  /** @deprecated Use a `"latest"` rule. */
  updateAllowlist: string[]
  /** @deprecated Use a `"hold"` rule. */
  updateDenylist: string[]
  cooldown: CooldownConfig
}

/** What `.always-up-to-date.json` may contain: any subset of the config. */
export type ConfigFile = Partial<AlwaysUpToDateConfig> & { $schema?: string }

export interface RegistryConfig {
  registry: string
  scopedRegistries: Record<string, string>
  authTokens: Record<string, string>
  alwaysAuth?: boolean
  strictSSL?: boolean
  ca?: string | string[]
  cafile?: string
}
