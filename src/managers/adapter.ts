import type { SuccessCheck } from '@/commandRunner'
import type {
  ManifestPlan,
  OutdatedEntry,
  PackageInfo,
  SupportedPackageManager,
} from '@/types'
import type { Catalogs } from '@/utils/dependencySpecs'
import type { ControllingOverride } from '@/utils/overrides'
import type { SaveStyle } from '@/utils/saveStyle'

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
  /** Every package that moves. */
  names: string[]
  /** Packages moving to `wanted`: the manager installs them by name. */
  withinRange: string[]
  /** Packages moving past their range, to this version: their spec changes. */
  beyondRange: Record<string, string>
  /** Each manifest with something moving, root first. A single-package project has the root only. */
  manifests: ManifestPlan[]
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
  /** How the manager writes a new spec, read from where its current version keeps that setting. */
  saveStyle(cwd: string): SaveStyle
  /** Packages pinned by an override this manager enforces. */
  overrides(cwd: string): Record<string, ControllingOverride>
}
