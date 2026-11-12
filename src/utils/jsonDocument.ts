import type { ReleaseType } from 'semver'
import type { PipelineStep } from '@/stepError'
import type { Reason, SupportedPackageManager, UpdateResult } from '@/types'
import packageJson from '../../package.json'
import type { OUTCOMES } from './reasons'

/**
 * The `--json` documents (#201), described by `schema/output.schema.json`.
 * Every document carries `version`, the format's version: 4.x may add fields
 * and reason codes within version 1, so a consumer branches on `outcome`, not
 * on the set of codes. Loaded by the command actions and `reportFailure`
 * only, never by a command definition, so `--version` and `help` pay nothing.
 */
export const OUTPUT_VERSION = 1

/** One planned row, with every key always present. */
interface JsonRow {
  name: string
  /** The manifest's directory relative to the project root; `"."` for the root or a single package. */
  workspace: string
  /** The installed version; `null` when the dependency is not installed. */
  current: string | null
  wanted: string
  latest: string
  /** The version the row moves to; `null` when it is held. */
  target: string | null
  updateType: ReleaseType | null
  outcome: (typeof OUTCOMES)[number]
  reason: Reason
  warnings: Reason[]
  /** Age in days of the release judged by the cooldown; `null` when nothing judged the row. */
  releaseAgeDays: number | null
}

interface PlanDocument {
  version: typeof OUTPUT_VERSION
  /** The version of autd that printed the document. */
  autd: string
  command: 'check' | 'update'
  /** `plan` for `check` and `--dry-run`; `applied` once `update` has run. */
  phase: 'plan' | 'applied'
  manager: SupportedPackageManager
  /** The workspace member the run started from, relative to the root; `null` outside a member run. */
  member: string | null
  rows: JsonRow[]
}

export interface ErrorDocument {
  version: typeof OUTPUT_VERSION
  autd: string
  command: 'check' | 'update'
  error: {
    /** The step that failed; `null` outside a step (a malformed config). */
    step: PipelineStep | null
    message: string
    manifestWritten: boolean
  }
}

const outcomeOf = (row: UpdateResult): JsonRow['outcome'] => {
  if (row.updated) return 'update'
  if (row.reason.code === 'not-applied') return 'not-applied'
  if (row.reason.code === 'not-targeted') return 'not-targeted'
  return 'held'
}

/** A planned row in the document's shape: fixed key order, no key left out. */
export const rowOf = (row: UpdateResult): JsonRow => ({
  name: row.name,
  workspace: row.workspace ?? '.',
  current: row.current === 'missing' ? null : row.current,
  wanted: row.wanted,
  latest: row.latest,
  target: row.target ?? null,
  updateType: row.updateType,
  outcome: outcomeOf(row),
  reason: { code: row.reason.code, message: row.reason.message },
  warnings: (row.warnings ?? []).map(({ code, message }) => ({
    code,
    message,
  })),
  releaseAgeDays: row.releaseAge ?? null,
})

export const planDocument = ({
  command,
  phase,
  manager,
  member,
  results,
}: {
  command: PlanDocument['command']
  phase: PlanDocument['phase']
  manager: SupportedPackageManager
  member?: string
  results: UpdateResult[]
}): PlanDocument => ({
  version: OUTPUT_VERSION,
  autd: packageJson.version,
  command,
  phase,
  manager,
  member: member ?? null,
  rows: results.map(rowOf),
})

export const errorDocument = (
  command: ErrorDocument['command'],
  error: ErrorDocument['error'],
): ErrorDocument => ({
  version: OUTPUT_VERSION,
  autd: packageJson.version,
  command,
  error,
})

/** The one thing `--json` puts on stdout. */
export const printJson = (document: PlanDocument | ErrorDocument): void => {
  console.log(JSON.stringify(document, null, 2))
}
