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
  /** Read public npm packages' versions through deps.dev. Default true. */
  depsDev: boolean
}

/** What `.always-up-to-date.json` may contain: any subset of the config. */
export type ConfigFile = Partial<AlwaysUpToDateConfig> & { $schema?: string }

/** What one `//host[:port]/path/:` prefix of .npmrc holds. */
export interface RegistryCredentials {
  /** `_authToken`, sent as Bearer. */
  authToken?: string
  /** `_auth` (base64 user:pass), sent as Basic unchanged. */
  auth?: string
  username?: string
  /** `_password`, base64 as .npmrc stores it. */
  password?: string
  /** Absolute, resolved against cwd. */
  certfile?: string
  /** Absolute, resolved against cwd. */
  keyfile?: string
}

/**
 * The Agent's `proxyEnv`, already resolved from .npmrc and the environment.
 * A type alias: an interface isn't assignable to http.ProxyEnv's index signature.
 */
export type ProxySettings = {
  HTTPS_PROXY?: string
  HTTP_PROXY?: string
  NO_PROXY?: string
}

export interface RegistryConfig {
  /** Default https://registry.npmjs.org/ */
  registry: string
  /** '@scope' → registry URL */
  scopedRegistries: Record<string, string>
  /** '//host[:port]/path/' (as written) → its credentials */
  credentials: Record<string, RegistryCredentials>
  /** cafile (if readable), else ca / ca[]; undefined means Node's default store */
  ca?: string[]
  strictSSL: boolean
  proxy: ProxySettings
  fetchRetries: number
  /** Milliseconds */
  fetchTimeout: number
  maxSockets: number
}

export interface RegistryVersion {
  version: string
  deprecated: boolean
  /** The deprecation message, when the source gives a non-empty one. */
  deprecatedReason?: string
  /** ISO 8601, when the source has it (deps.dev always; packuments only with `time`). */
  publishedAt?: string
}

export interface RegistryPackage {
  name: string
  /** Always one of `versions`. */
  latest: string
  /** Every version whose string is canonical semver, ascending (semver.compare). */
  versions: RegistryVersion[]
  source: 'deps.dev' | 'packument'
}

export type LookupFailureKind = 'not-found' | 'request' | 'invalid'

export type PackageLookup =
  | { ok: true; package: RegistryPackage }
  | { ok: false; name: string; kind: LookupFailureKind; reason: string }
