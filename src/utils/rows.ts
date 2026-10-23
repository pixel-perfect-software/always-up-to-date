import type { PackageInfo, UpdateResult } from '@/types'
import type { OutdatedRow } from './logger'

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
  note:
    info.wanted !== info.current && info.wanted !== info.latest
      ? `in range: ${info.wanted}`
      : undefined,
})

/** A row for the "updating" table: current → target, flagged when it leaves its range. */
export const toUpdatingRow = (result: UpdateResult): OutdatedRow => ({
  name: result.name,
  current: result.current,
  latest: result.target ?? result.latest,
  note: result.target !== result.wanted ? 'beyond range' : undefined,
})
