import type { ReleaseType } from 'semver'

export type SupportedPackageManager = 'npm' | 'yarn' | 'pnpm' | 'bun'

/** One manifest's versions of an outdated package, in a workspace project. */
export interface WorkspaceVersion {
  /** The manifest's directory relative to the root, POSIX separators; '.' is the root. */
  path: string
  current: string
  wanted: string
}

export interface PackageInfo {
  name: string
  current: string
  /** Highest version the manifest range allows: what the manager would install. */
  wanted: string
  latest: string
  /**
   * Workspace projects only: each manifest declaring the package, root first,
   * then by path. `current` and `wanted` above repeat the root's, else the
   * first member's.
   */
  workspaces?: WorkspaceVersion[]
}

/** Discovery's unit in a workspace project: one package as one manifest declares it. */
export interface OutdatedEntry {
  /** As the manager reports it; the pipeline re-keys it by the owner's dependency key. */
  name: string
  current: string
  /** Highest version the owning manifest's range allows. */
  wanted: string
  latest: string
  /** The owning manifest's directory relative to the root ('.' = root). */
  workspace: string
}

export interface UpdateResult {
  name: string
  /** Workspace projects only: the manifest this row belongs to. Absent in single-package projects. */
  workspace?: string
  current: string
  wanted: string
  latest: string
  /** Version the update moves to, when `updated`. Equal to `wanted` when it stays within the range. */
  target?: string
  updateType: ReleaseType | null
  updated: boolean
  reason?: string
  /** Set when an update goes ahead despite a problem (a `latest` rule over a peer conflict). */
  warning?: string
  releaseAge?: number
}

/** One manifest's share of the plan. */
export interface ManifestPlan {
  /** The manifest's directory relative to the root ('.' is the root). */
  path: string
  withinRange: string[]
  beyondRange: Record<string, string>
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
