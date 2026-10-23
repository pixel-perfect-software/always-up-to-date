import type { PackageInfo, UpdateResult } from '@/types'
import type { OutdatedRow, SkippedRow } from './logger'

const inRangeNote = (
  current: string,
  wanted: string,
  latest: string,
): string | undefined =>
  wanted !== current && wanted !== latest ? `in range: ${wanted}` : undefined

/** A row for the outdated table: current → latest, noting the in-range version when it differs. */
export const toOutdatedRow = (
  name: string,
  info: PackageInfo,
  releaseAge?: number,
): OutdatedRow => ({
  name,
  current: info.current,
  latest: info.latest,
  releaseAge,
  note: inRangeNote(info.current, info.wanted, info.latest),
})

/**
 * The outdated table's rows for one package: one per manifest that declares
 * it in a workspace project, else the single row.
 */
export const toOutdatedRows = (
  name: string,
  info: PackageInfo,
  releaseAge?: number,
): OutdatedRow[] =>
  info.workspaces
    ? info.workspaces.map((version) => ({
        name,
        workspace: version.path,
        current: version.current,
        latest: info.latest,
        releaseAge,
        note: inRangeNote(version.current, version.wanted, info.latest),
      }))
    : [toOutdatedRow(name, info, releaseAge)]

/** A row for the "updating" table: current → target, flagged when it leaves its range. */
export const toUpdatingRow = (result: UpdateResult): OutdatedRow => ({
  name: result.name,
  ...(result.workspace === undefined ? {} : { workspace: result.workspace }),
  current: result.current,
  latest: result.target ?? result.latest,
  note:
    [result.target !== result.wanted ? 'beyond range' : '', result.warning]
      .filter(Boolean)
      .join('; ') || undefined,
})

/** A row for a "skipped" table: current → latest with the reason it stays. */
export const toSkippedRow = (result: UpdateResult): SkippedRow => ({
  name: result.name,
  ...(result.workspace === undefined ? {} : { workspace: result.workspace }),
  current: result.current,
  latest: result.latest,
  updateType: result.updateType,
  reason: result.reason,
})
