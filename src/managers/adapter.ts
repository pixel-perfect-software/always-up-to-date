import type { SuccessCheck } from '@/commandRunner'
import type {
  ManifestPlan,
  OutdatedEntry,
  PackageInfo,
  RegistryConfig,
  ReleaseAgeGate,
  SupportedPackageManager,
} from '@/types'
import type { Catalogs } from '@/utils/dependencySpecs'
import type { InstalledPackage } from '@/utils/installed'
import type {
  EmptyRegistryPolicy,
  NpmrcLayer,
  NpmrcSources,
  NpmrcView,
} from '@/utils/npmrcLoader'
import type { ControllingOverride } from '@/utils/overrides'
import type { PeerRequirement } from '@/utils/peers'
import type { SaveStyle } from '@/utils/saveStyle'
import type { RangedDependency } from './yarn/lockfile'

/** One package.json in the project: the root, or a workspace member. */
export interface WorkspaceManifest {
  /** The manifest's directory relative to the root, POSIX separators; '.' is the root. */
  path: string
  /** The manifest's `name`, when it has one. */
  name?: string
}

/** The project's layout as the manager sees it, read once per run. */
export interface Workspace {
  /** Discovery and apply cover every member. */
  isWorkspace: boolean
  /**
   * Catalogs that hold versions instead of package.json: name → spec by
   * catalog name (`default` for `catalog:`), as the writers read them.
   */
  catalogs: Catalogs
  /**
   * The root (`{ path: '.' }`) first, then each member directory the
   * workspace patterns match, sorted by path. Only the root outside a workspace.
   */
  manifests: WorkspaceManifest[]
  /**
   * A member run (#123): the one manifest discovery reads.
   * Set by the pipeline from `Project.member`; `readWorkspace` never sets it.
   */
  member?: WorkspaceManifest
}

/** What discovery found, in the shape the project calls for. */
export type Discovery =
  | { kind: 'single'; outdated: Record<string, PackageInfo> }
  | { kind: 'workspace'; entries: OutdatedEntry[] }

/**
 * Runs the manager with `args` as one pipeline step. A failure rejects with
 * a `StepError`; `manifestWritten` records whether autd had already written
 * a manifest when it happened.
 */
export type RunManager = (
  args: string[],
  options?: { isSuccess?: SuccessCheck; manifestWritten?: boolean },
) => Promise<string>

/** What the policy chose to move, split as `splitUpdates` returns it. */
export interface ApplyPlan {
  /** Every package that moves, except the pinned ones (`applyPinned` moves those first). */
  names: string[]
  /** Packages moving to `wanted`: the manager installs them by name. */
  withinRange: string[]
  /** Packages moving past their range, to this version: their spec changes. */
  beyondRange: Record<string, string>
  /** Each manifest with something moving, root first. A single-package project has the root only. */
  manifests: ManifestPlan[]
}

/** A lockfile that stands in for node_modules: its name, and its reader. */
export interface LockedInstall {
  /** The lockfile, for the debug line: `package-lock.json`. */
  file: string
  /** Installed copies by `rowKey`, as `readInstalledPackages` returns them. */
  read(
    cwd: string,
    rows: { name: string; workspace?: string }[],
  ): Record<string, InstalledPackage>
  /**
   * Installed packages' peer ranges, keyed by the package they constrain, as
   * `readInstalledPeers` reads them from node_modules (#232). Absent when
   * node_modules exists and decides (berry with the node-modules linker).
   */
  peers?(cwd: string): Map<string, PeerRequirement[]>
}

/** What pinning a cooldown fallback (#147, `applyPinned`) needs from the manager. */
export interface Pinning {
  /** The install after autd rewrote a manifest: it keeps locked versions the specs still allow. */
  install: string[]
  /** Writes catalog entries, for a manager with catalogs (`updatePNPMWorkspaceYAML`'s signature). */
  writeCatalog?(
    cwd: string,
    versions: Record<string, string>,
    style: SaveStyle,
    catalog: string,
  ): Promise<void>
  /**
   * A lockfile keyed by spec (yarn) resolves a restored range again, to the
   * newest version: this records each range against the version pinned
   * under its exact spec, before the second install.
   */
  relock?(cwd: string, pins: RangedDependency[]): void
}

/**
 * Everything specific to one package manager. The pipeline
 * (`src/pipeline.ts`) does the rest the same way for each.
 */
export interface ManagerAdapter {
  name: SupportedPackageManager
  /** The lockfile that marks a project as this manager's. */
  lockfile: string
  readWorkspace(cwd: string): Workspace
  /**
   * The directory this manager treats as the project for `dir` (the nearest
   * package.json): the workspace root that lists it, else `dir` itself.
   * Throws a `detect` StepError where the manager refuses to run there
   * (berry, a directory its root does not list).
   */
  projectRoot(dir: string): string
  /**
   * Whether a range resolves to `latest` when `latest` satisfies it, before
   * the highest satisfying version (`wantedVersion`'s `preferLatest`).
   * Default true; yarn berry resolves to the highest (#107).
   */
  prefersLatestInRange?(cwd: string): boolean
  /**
   * Whether the manager installs the newest in-range version whose
   * `engines.node` fits its Node, over a newer one that excludes it (#200).
   * Default false: pnpm and bun install the highest satisfying version
   * whatever the engines (probed 2026-11-07), and yarn v1 and berry were not
   * verified. npm: npm-pick-manifest's `engineOk` sort; npm 12.2.2 and 11.19.1
   * agree. Takes `cwd` because the yarn adapter serves v1 and berry.
   */
  skipsEnginesExcluded?(cwd: string): boolean
  /** Writes the specs the manager does not write itself, then runs its update commands. */
  apply(
    run: RunManager,
    cwd: string,
    plan: ApplyPlan,
    workspace: Workspace,
  ): Promise<void>
  /**
   * The versions installed for these rows after apply, keyed by `rowKey`,
   * for a manager whose installs can't be read from node_modules (yarn
   * berry's PnP). Without it the pipeline reads node_modules.
   */
  installed?(
    run: RunManager,
    cwd: string,
    rows: { name: string; workspace?: string }[],
  ): Promise<Record<string, string>>
  /**
   * The `.npmrc` layers this manager reads, highest first, merged per key
   * (`mergeNpmrcLayers`). Without it, npm's (`npmNpmrcLayers`). Called once,
   * on the session's first use.
   */
  npmrcLayers?(cwd: string, sources: NpmrcSources): NpmrcLayer[]
  /**
   * Whether an empty registry value fails this manager's run (default npm's).
   * `registryConfigFrom` records an empty value as unusable only where it does.
   */
  emptyRegistry?: EmptyRegistryPolicy
  /**
   * The run's registry config for this manager: the merged `.npmrc` view
   * (`fromNpmrc`, built from `npmrc`), adjusted where the manager reads
   * registries from somewhere else too (bun's bunfig.toml). Called once, on
   * the session's first use. Without it the view is used as is.
   */
  registryConfig?(
    cwd: string,
    fromNpmrc: RegistryConfig,
    sources: NpmrcSources,
    npmrc: NpmrcView,
  ): RegistryConfig
  /** How the manager writes a new spec, read from where its current version keeps that setting. */
  saveStyle(cwd: string): SaveStyle
  /**
   * Where installed versions come from when node_modules can't say (#107):
   * the lockfile and its reader, or undefined to read node_modules (and fail
   * discovery with the install command when there is none). npm returns
   * package-lock.json's reader when the root has no node_modules.
   */
  installedFromLockfile?(cwd: string): LockedInstall | undefined
  /**
   * The manager's release-age gate (#168): versions younger than it are never
   * installed, so autd never proposes them. Read from the manager's own
   * settings where `managerRegistryConfig` builds the registry config (`npmrc`
   * is the merged view of its `.npmrc` layers). Undefined when it has none
   * set. Yarn berry sets `releaseAgeGate` in its `registryConfig` instead.
   */
  releaseAgeGate?(
    cwd: string,
    sources: NpmrcSources,
    npmrc: NpmrcView,
  ): ReleaseAgeGate | undefined
  /** How a cooldown fallback is pinned and restored with this manager. */
  pinning(cwd: string): Pinning
  /**
   * Whether a workspace member's moves go through `applyPinned` (installs at
   * the root) instead of `apply`. yarn v1 says yes (#127): its only per-member
   * command, `workspace <name> upgrade`, resolves with the member directory's
   * registry settings, where `~/.npmrc` outranks the root's `.npmrc`, while a
   * root `install` resolves with the root's, as discovery does.
   */
  pinMembers?(cwd: string): boolean
  /**
   * The Node version the manager judges a package's `engines` by when the
   * project sets one (pnpm's `nodeVersion` in pnpm-workspace.yaml), else
   * undefined: the manager uses the Node it runs on (#199).
   */
  nodeVersion?(cwd: string): string | undefined
  /** Packages pinned by an override this manager enforces. */
  overrides(cwd: string): Record<string, ControllingOverride>
}
