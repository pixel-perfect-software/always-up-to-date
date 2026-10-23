import type { SuccessCheck } from '@/commandRunner'
import type { PackageInfo, SupportedPackageManager } from '@/types'
import type { ControllingOverride } from '@/utils/overrides'
import type { SaveStyle } from '@/utils/saveStyle'

/** The project's layout as the manager sees it, read once per run. */
export interface Workspace {
  /** Discovery and apply cover every member. */
  isWorkspace: boolean
  /** Catalogs that hold versions instead of package.json, by name. */
  catalogs: string[]
}

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
  /** The discovery result the plan was made from. */
  discovered: Record<string, PackageInfo>
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
  /** Outdated packages as the manager reports them, keyed by its own names. */
  discover(
    run: RunManager,
    cwd: string,
    workspace: Workspace,
  ): Promise<Record<string, PackageInfo>>
  /** Writes the specs the manager does not write itself, then runs its update commands. */
  apply(
    run: RunManager,
    cwd: string,
    plan: ApplyPlan,
    workspace: Workspace,
  ): Promise<void>
  /** How the manager writes a new spec, read from where its current version keeps that setting. */
  saveStyle(cwd: string): SaveStyle
  /** Packages pinned by an override this manager enforces. */
  overrides(cwd: string): Record<string, ControllingOverride>
}
