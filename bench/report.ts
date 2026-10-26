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
