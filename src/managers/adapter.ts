import type { SuccessCheck } from '@/commandRunner'
import type {
  ManifestPlan,
  OutdatedEntry,
  PackageInfo,
  RegistryConfig,
  SupportedPackageManager,
} from '@/types'
import type { Catalogs } from '@/utils/dependencySpecs'
import type {
  EmptyRegistryPolicy,
  NpmrcLayer,
  NpmrcSources,
  NpmrcView,
} from '@/utils/npmrcLoader'
import type { ControllingOverride } from '@/utils/overrides'
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
   * A member run (#123): the one manifest discovery reads and apply moves.
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
   * Yarn berry only, until #107: a project autd can't read natively yet is
   * discovered through the manager, keyed by manifest key. Undefined means
   * autd discovers natively (`discoverFromRegistry`).
   */
  ownDiscovery?(
    cwd: string,
  ): ((run: RunManager, workspace: Workspace) => Promise<Discovery>) | undefined
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
  /** How a cooldown fallback is pinned and restored with this manager. */
  pinning(cwd: string): Pinning
  /** Packages pinned by an override this manager enforces. */
  overrides(cwd: string): Record<string, ControllingOverride>
}
