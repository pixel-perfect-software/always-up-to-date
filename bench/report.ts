import { stripVTControlCharacters } from 'util'
import { TARGETS, type Target } from './targets'

/** One command's timing from hyperfine's JSON: seconds, and peak memory in bytes when it reports it. */
export type Timing = {
  mean: number
  stddev: number
  median: number
  runs: number
  peakMemory?: number
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null

const numberAt = (
  record: Record<string, unknown>,
  key: string,
): number | undefined => {
  const value = record[key]
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * The timings, in command order, of a `hyperfine --export-json` file. hyperfine
 * 2 writes `schema_version: 2` and, per result, a `summary` of each metric
 * (`time_wall_clock`, `memory_peak_resident`, …) with `mean`, `stddev`,
 * `median`, `min`, `max` and `count`; 1.x wrote `mean` on the result itself.
 */
export const parseHyperfine = (text: string): Timing[] => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('hyperfine wrote no JSON')
  }

  if (
    !isRecord(parsed) ||
    typeof parsed.schema_version !== 'number' ||
    parsed.schema_version < 2
  ) {
    throw new Error(
      'hyperfine did not write JSON schema version 2 or later: install hyperfine 2 or later',
    )
  }
  if (!Array.isArray(parsed.results) || parsed.results.length === 0) {
    throw new Error('hyperfine reported no results')
  }

  return parsed.results.map((result: unknown, index) => {
    const summary = isRecord(result) ? result.summary : undefined
    const time = isRecord(summary) ? summary.time_wall_clock : undefined
    const memory = isRecord(summary) ? summary.memory_peak_resident : undefined
    const mean = isRecord(time) ? numberAt(time, 'mean') : undefined
    // A single run has no deviation: hyperfine writes `"stddev": null`.
    const stddev =
      isRecord(time) && time.stddev === null
        ? 0
        : isRecord(time)
          ? numberAt(time, 'stddev')
          : undefined
    const median = isRecord(time) ? numberAt(time, 'median') : undefined
    const runs = isRecord(time) ? numberAt(time, 'count') : undefined
    if (
      mean === undefined ||
      stddev === undefined ||
      median === undefined ||
      runs === undefined
    ) {
      throw new Error(`hyperfine result ${index} has no wall-clock summary`)
    }
    return {
      mean,
      stddev,
      median,
      runs,
      peakMemory: isRecord(memory) ? numberAt(memory, 'max') : undefined,
    }
  })
}

/** The major version in `hyperfine --version` output (`hyperfine 2.0.0`). */
export const hyperfineMajor = (text: string): number | undefined => {
  const match = /(\d+)\.\d+/.exec(text)
  return match ? Number(match[1]) : undefined
}

/** `126 ms` below a tenth of a second, else `0.92 s`; `14.8 s` from ten seconds. */
export const formatSeconds = (seconds: number): string => {
  if (seconds < 0.1) return `${Math.round(seconds * 1000)} ms`
  return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`
}

/**
 * A signed difference in `formatSeconds`' units: `+0.12 s`, `-8 ms`, `+0 ms`.
 * The sign is the rounded value's, so noise under half a millisecond is `+0 ms`.
 */
export const formatDifference = (seconds: number): string => {
  const text = formatSeconds(Math.abs(seconds))
  return `${seconds < 0 && /[1-9]/.test(text) ? '-' : '+'}${text}`
}

/**
 * How many rows `autd update --dry-run --json` plans to move: the ones with
 * `outcome: "update"` in the version 1 document (#201). The cooldown rows only
 * measure something when this is above zero, because a row with no target never
 * reaches the gate. An error document throws with autd's message. A bare array
 * is the 3.x output (`updated: true`), still counted so `AUTD_BENCH_CLI` can
 * time a build from before 4.0.
 */
export const movingRows = (text: string): number => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('update --dry-run --json printed no JSON')
  }

  if (Array.isArray(parsed)) {
    return parsed.filter((row) => isRecord(row) && row.updated === true).length
  }
  if (isRecord(parsed) && Array.isArray(parsed.rows)) {
    return parsed.rows.filter(
      (row) => isRecord(row) && row.outcome === 'update',
    ).length
  }
  const failure = isRecord(parsed) ? parsed.error : undefined
  if (isRecord(failure) && typeof failure.message === 'string') {
    throw new Error(
      typeof failure.step === 'string'
        ? `Failed during ${failure.step}: ${failure.message}`
        : failure.message,
    )
  }
  throw new Error('update --dry-run --json printed neither rows nor an error')
}

/**
 * The lines in what timed runs printed where autd says a host throttled the run
 * (`throttledNotice`), one per throttled run, without color. A throttled run
 * timed a fallback, not the path the row names (#174).
 */
export const throttledLines = (output: string): string[] =>
  stripVTControlCharacters(output)
    .split(/\r?\n/)
    .filter((line) => /Throttled by \S+ \(\d+ requests?\)/.test(line))
    .map((line) => line.trim())

/** Megabytes (10^6 bytes), or `n/a` when hyperfine reported none. */
export const formatMemory = (bytes: number | undefined): string =>
  bytes === undefined ? 'n/a' : `${Math.round(bytes / 1e6)} MB`

/** `0.92 s ± 0.03` or `126 ms ± 4`: the mean and its standard deviation, in the mean's unit. */
export const formatTiming = (timing: Timing): string =>
  timing.mean < 0.1
    ? `${formatSeconds(timing.mean)} ± ${Math.round(timing.stddev * 1000)}`
    : `${formatSeconds(timing.mean)} ± ${timing.stddev.toFixed(2)}`

/** A markdown table; the first column is left aligned, the rest right aligned. */
export const renderTable = (header: string[], rows: string[][]): string => {
  const widths = header.map((cell, column) =>
    Math.max(cell.length, ...rows.map((row) => row[column].length)),
  )
  const line = (cells: string[]): string =>
    `| ${cells
      .map((cell, column) =>
        column === 0
          ? cell.padEnd(widths[column])
          : cell.padStart(widths[column]),
      )
      .join(' | ')} |`
  const divider = `|${widths
    .map((width, column) =>
      column === 0 ? '-'.repeat(width + 2) : `${'-'.repeat(width + 1)}:`,
    )
    .join('|')}|`
  return [line(header), divider, ...rows.map(line)].join('\n')
}

/** The difference of two medians, in seconds. Runs are not paired (separate hyperfine invocations), so this subtracts two independently taken medians; negative when `a` is the faster. */
export const medianDifference = (a: Timing, b: Timing): number =>
  a.median - b.median

/**
 * The names whose full packument a run read for publish times (#176): autd logs
 * `Reading the full packument of <name> for publish times` at debug level only
 * when a body came back. Sorted, once each, without color.
 */
export const fullPackumentReads = (output: string): string[] => {
  const names = new Set<string>()
  for (const line of stripVTControlCharacters(output).split(/\r?\n/)) {
    const match = /Reading the full packument of (\S+) for publish times/.exec(
      line,
    )
    if (match) names.add(match[1])
  }
  return [...names].sort()
}

/** A target that was measured. */
export type MeasuredRow = {
  target: Target
  status: 'measured'
  label: string
  warm: Timing
  cold: Timing
  /** Rows the moving config plans to update: each one reaches the cooldown gate. */
  targets: number
  /** `MOVING_CONFIG`, cold. */
  moving: Timing
  /** `COOLDOWN_CONFIG`, cold. */
  cooldownCold: Timing
  /** `COOLDOWN_CONFIG`, warm. */
  cooldownWarm: Timing
  /** Packuments one untimed cooldown `check` read in full; absent when that run failed or was not made. */
  fullPackuments?: string[]
}

/** A target that failed, or that a host throttled (#174): no numbers. */
export type UnmeasuredRow = {
  target: Target
  status: 'failed' | 'throttled'
  error: string
}

export type StartupResult =
  | { status: 'measured'; version: Timing; bare: Timing }
  | { status: 'failed'; error: string }

/** What `AUTD_BENCH_JSON` writes. */
export type BenchDocument = {
  version: 1
  autd: string
  node: string
  platform: string
  arch: string
  project: string
  rows: (MeasuredRow | UnmeasuredRow)[]
  startup?: StartupResult
}

const fail = (path: string, expected: string): never => {
  throw new Error(`bench document: ${path} is not ${expected}`)
}

const stringAt = (
  record: Record<string, unknown>,
  key: string,
  path: string,
): string => {
  const value = record[key]
  return typeof value === 'string' ? value : fail(`${path}.${key}`, 'a string')
}

const recordAt = (
  record: Record<string, unknown>,
  key: string,
  path: string,
): Record<string, unknown> => {
  const value = record[key]
  return isRecord(value) ? value : fail(`${path}.${key}`, 'an object')
}

const requiredNumber = (
  record: Record<string, unknown>,
  key: string,
  path: string,
): number => numberAt(record, key) ?? fail(`${path}.${key}`, 'a number')

const timingAt = (
  record: Record<string, unknown>,
  key: string,
  path: string,
): Timing => {
  const timing = recordAt(record, key, path)
  const at = `${path}.${key}`
  const peak = timing.peakMemory
  if (peak !== undefined && numberAt(timing, 'peakMemory') === undefined) {
    fail(`${at}.peakMemory`, 'a number')
  }
  return {
    mean: requiredNumber(timing, 'mean', at),
    stddev: requiredNumber(timing, 'stddev', at),
    median: requiredNumber(timing, 'median', at),
    runs: requiredNumber(timing, 'runs', at),
    peakMemory: peak === undefined ? undefined : (peak as number),
  }
}

const rowAt = (value: unknown, index: number): MeasuredRow | UnmeasuredRow => {
  const path = `rows[${index}]`
  if (!isRecord(value)) return fail(path, 'an object')
  const target = value.target
  if (!TARGETS.some((name) => name === target)) {
    return fail(`${path}.target`, `one of ${TARGETS.join(', ')}`)
  }
  const name = target as Target
  if (value.status === 'failed' || value.status === 'throttled') {
    return {
      target: name,
      status: value.status,
      error: stringAt(value, 'error', path),
    }
  }
  if (value.status !== 'measured') {
    return fail(`${path}.status`, 'measured, failed or throttled')
  }
  const packuments = value.fullPackuments
  if (
    packuments !== undefined &&
    !(
      Array.isArray(packuments) &&
      packuments.every((entry) => typeof entry === 'string')
    )
  ) {
    return fail(`${path}.fullPackuments`, 'a list of strings')
  }
  return {
    target: name,
    status: 'measured',
    label: stringAt(value, 'label', path),
    warm: timingAt(value, 'warm', path),
    cold: timingAt(value, 'cold', path),
    targets: requiredNumber(value, 'targets', path),
    moving: timingAt(value, 'moving', path),
    cooldownCold: timingAt(value, 'cooldownCold', path),
    cooldownWarm: timingAt(value, 'cooldownWarm', path),
    ...(packuments === undefined
      ? {}
      : { fullPackuments: packuments as string[] }),
  }
}

const startupAt = (value: unknown): StartupResult => {
  const path = 'startup'
  if (!isRecord(value)) return fail(path, 'an object')
  if (value.status === 'failed') {
    return { status: 'failed', error: stringAt(value, 'error', path) }
  }
  if (value.status !== 'measured') {
    return fail(`${path}.status`, 'measured or failed')
  }
  return {
    status: 'measured',
    version: timingAt(value, 'version', path),
    bare: timingAt(value, 'bare', path),
  }
}

/** The document `AUTD_BENCH_JSON` wrote, checked field by field; throws a message naming the first wrong path. */
export const parseBenchDocument = (text: string): BenchDocument => {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error('bench document: not JSON')
  }
  if (!isRecord(parsed)) return fail('the document', 'an object')
  if (parsed.version !== 1) {
    return fail('version', '1')
  }
  if (!Array.isArray(parsed.rows)) return fail('rows', 'a list')
  return {
    version: 1,
    autd: stringAt(parsed, 'autd', 'document'),
    node: stringAt(parsed, 'node', 'document'),
    platform: stringAt(parsed, 'platform', 'document'),
    arch: stringAt(parsed, 'arch', 'document'),
    project: stringAt(parsed, 'project', 'document'),
    rows: parsed.rows.map(rowAt),
    ...(parsed.startup === undefined
      ? {}
      : { startup: startupAt(parsed.startup) }),
  }
}
