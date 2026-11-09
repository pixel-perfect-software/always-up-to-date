import { blue, bold, cyan, gray, green, red, yellow } from 'colorette'
import type { AlwaysUpToDateConfig, UpdateResult } from '@/types'
import { formatAgeDays } from './duration'
import { scrub } from './redaction'
import {
  groupResults,
  NOTE_SEPARATOR,
  type Outcome,
  type ReportPhase,
  type ReportRow,
  splitAtChange,
} from './report'
import { workspaceLabel } from './workspaceRows'

export type { ReportPhase }

export const pluralize = (
  count: number,
  singular: string,
  plural?: string,
): string => `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`

/** The config fields the logger reads. */
export type LoggerConfig = Partial<
  Pick<AlwaysUpToDateConfig, 'debug' | 'silent'>
>

/** Each section's heading and its summary wording, and the heading's color. */
const SECTIONS: Record<
  Outcome,
  {
    heading: (phase: ReportPhase, manager: string) => string
    summary: (phase: ReportPhase, manager: string) => string
    color: (text: string) => string
  }
> = {
  update: {
    heading: (phase) => (phase === 'plan' ? 'Would update' : 'Updated'),
    summary: (phase) => (phase === 'plan' ? 'to update' : 'updated'),
    color: green,
  },
  'not-applied': {
    heading: (_, manager) => `Left in place by ${manager}`,
    summary: (_, manager) => `left in place by ${manager}`,
    color: yellow,
  },
  cooldown: {
    heading: () => 'Held by cooldown',
    summary: () => 'held by cooldown',
    color: cyan,
  },
  range: {
    heading: () => 'Past the range in package.json',
    summary: () => 'past the range',
    color: cyan,
  },
  rule: {
    heading: () => 'Held by a rule',
    summary: () => 'held by a rule',
    color: cyan,
  },
  override: {
    heading: () => 'Held by an override',
    summary: () => 'held by an override',
    color: cyan,
  },
  peer: {
    heading: () => 'Held by a peer conflict',
    summary: () => 'held by a peer conflict',
    color: cyan,
  },
  deprecated: {
    heading: () => 'Held as deprecated',
    summary: () => 'held as deprecated',
    color: cyan,
  },
  license: {
    heading: () => 'Held for a license change',
    summary: () => 'held for a license change',
    color: cyan,
  },
  engines: {
    heading: () => 'Held by engines.node',
    summary: () => 'held by engines.node',
    color: cyan,
  },
  together: {
    heading: () => 'Held with another manifest',
    summary: () => 'held with another manifest',
    color: cyan,
  },
  other: {
    heading: () => 'Not updated',
    summary: () => 'not updated',
    color: yellow,
  },
}

/** The manifests a row covers: one or two by path, else a count. */
const whereOf = (workspaces: string[]): string =>
  workspaces.length <= 2
    ? workspaces.map(workspaceLabel).join(', ')
    : `${workspaces.length} manifests`

class Logger {
  private quiet = false
  private debugEnabled = false
  private jsonOutput = false

  /** Applies the loaded config. Until it is called, debug is off and output is not quiet. */
  configure(config: LoggerConfig): void {
    this.quiet = config.silent ?? false
    this.debugEnabled = config.debug ?? false
  }

  setQuiet(quiet: boolean): void {
    this.quiet = quiet
  }

  /**
   * `--json` mode: stdout carries only the JSON document. Progress output is
   * dropped; errors, warnings and debug lines go to stderr.
   */
  setJsonOutput(jsonOutput: boolean): void {
    this.jsonOutput = jsonOutput
  }

  /** Progress output is dropped when quiet and in `--json` mode. */
  private get muted(): boolean {
    return this.quiet || this.jsonOutput
  }

  /** Errors, warnings and debug lines: stderr in `--json` mode. */
  private diagnostic(line: string): void {
    if (this.quiet) return
    const shown = scrub(line)
    if (this.jsonOutput) console.error(shown)
    else console.log(shown)
  }

  info(message: string): void {
    if (!this.muted) console.log(`${blue('ℹ️')} ${message}`)
  }

  success(message: string): void {
    if (!this.muted) console.log(`${green('✅')} ${green(message)}`)
  }

  warn(message: string): void {
    this.diagnostic(`${yellow('⚠️')} ${yellow(message)}`)
  }

  error(message: string): void {
    this.diagnostic(`${red('❌')} ${red(message)}`)
  }

  /**
   * Quiet by default. Only prints when `debug: true` in the config.
   * Used for shell-out commands which are noisy for normal CLI use.
   */
  command(command: string): void {
    if (this.debugEnabled) this.diagnostic(`${gray('$')} ${gray(command)}`)
  }

  /** A workspace of more than one manifest; the catalog names are a debug line. */
  workspace(manager: string, manifests: number, catalogs: number): void {
    if (this.muted) return
    const parts = [pluralize(manifests, 'manifest')]
    if (catalogs > 0) parts.push(pluralize(catalogs, 'catalog'))
    console.log(
      `${blue('🏢')} ${blue(`${manager} workspace: ${parts.join(', ')}`)}`,
    )
  }

  /** A run from a workspace member (#123): the one manifest it covers. */
  memberRun(manager: string, memberPath: string, manifests: number): void {
    if (this.muted) return
    console.log(
      `${blue('🏢')} ${blue(`${manager} workspace member ${memberPath} (1 of ${manifests} manifests)`)}`,
    )
  }

  allUpToDate(): void {
    if (!this.muted) {
      console.log(`\n${green('🎉')} ${green('All packages are up to date.')}`)
    }
  }

  updatingHeader(manager: string, packages: number): void {
    if (this.muted) return
    console.log(
      `\n${blue('🔄')} ${bold(`Updating ${pluralize(packages, 'package')} with ${manager}`)}`,
    )
  }

  /**
   * Every candidate once, under what happened to it (or will), with its
   * reason, then one summary line. Rows that share a move and a reason across
   * manifests are one row; the manifest column is left out when every row is
   * the root's. A member run (#123) covers one manifest, so it has no
   * manifest column either. `next` is the command that applies a plan,
   * printed last when something would move; `elapsedMs` is how long an
   * applied `update` took, on its summary line.
   */
  report(
    results: UpdateResult[],
    manager: string,
    phase: ReportPhase,
    {
      member,
      next,
      elapsedMs,
    }: { member?: string; next?: string; elapsedMs?: number } = {},
  ): void {
    if (this.muted) return
    const sections = groupResults(results, phase)
    const ages = new Map(
      results
        .filter((r) => r.updated && r.releaseAge !== undefined)
        .map((r) => [r.name, r.releaseAge as number]),
    )
    const rows = sections.flatMap((section) => section.rows)
    const showWhere =
      member === undefined &&
      rows.some(
        (row) =>
          row.workspaces.length > 1 || (row.workspaces[0] ?? '.') !== '.',
      )
    const widths = {
      name: Math.max(0, ...rows.map((r) => r.name.length)),
      where: showWhere
        ? Math.max(...rows.map((r) => whereOf(r.workspaces).length))
        : 0,
      current: Math.max(0, ...rows.map((r) => r.current.length)),
      to: Math.max(0, ...rows.map((r) => r.to.length)),
    }
    for (const section of sections) {
      const { heading, color } = SECTIONS[section.outcome]
      const hint = section.hint ? `${NOTE_SEPARATOR}${section.hint}` : ''
      console.log(
        `\n${bold(color(heading(phase, manager)))} ${gray(`(${pluralize(section.packages, 'package')})${hint}`)}`,
      )
      for (const row of section.rows) {
        const age =
          section.outcome === 'update' ? ages.get(row.name) : undefined
        console.log(formatRow(row, widths, age))
      }
    }
    const counts = sections.map(
      (section) =>
        `${section.packages} ${SECTIONS[section.outcome].summary(phase, manager)}`,
    )
    if (counts.length === 0) return
    const moving = sections.some((section) => section.outcome === 'update')
    const took =
      elapsedMs === undefined
        ? ''
        : gray(`  (took ${formatElapsed(elapsedMs)})`)
    console.log(
      `\n${moving ? '' : bold('Nothing to update: ')}${counts.join(gray(NOTE_SEPARATOR))}${took}`,
    )
    if (moving && next) {
      const where = member === undefined ? '' : ' in the workspace root'
      console.log(
        `${gray('Run')} ${bold(cyan(next))}${gray(`${where} to apply.`)}`,
      )
    }
  }

  starting(operation: string, manager: string): void {
    if (this.muted) return
    console.log(`${blue('🚀')} ${blue(`${operation} with ${bold(manager)}`)}`)
  }

  clean(message: string): void {
    if (!this.muted) console.log(message)
  }

  debug(message: string): void {
    if (this.debugEnabled) this.diagnostic(gray(`  ${message}`))
  }
}

interface ColumnWidths {
  name: number
  /** 0 leaves the manifest column out. */
  where: number
  current: number
  to: number
}

const formatRow = (
  row: ReportRow,
  widths: ColumnWidths,
  releaseAge: number | undefined,
): string => {
  const name = bold(row.name.padEnd(widths.name))
  const where =
    widths.where > 0
      ? `  ${gray(whereOf(row.workspaces).padEnd(widths.where))}`
      : ''
  const current = row.current.padEnd(widths.current)
  const tail = [row.note]
  if (releaseAge !== undefined)
    tail.push(`released ${formatAgeDays(releaseAge)} ago`)
  const note = tail.filter(Boolean).join(NOTE_SEPARATOR)
  // The part of the version that changes, colored by the size of the step;
  // padded only when a note follows, outside the color codes.
  const [same, changed] = splitAtChange(row.current, row.to)
  const pad = note ? ' '.repeat(widths.to - row.to.length) : ''
  const to = `${same}${levelColor(row.level)(changed)}${pad}`
  return `  ${name}${where}  ${current} ${gray('→')} ${to}${note ? `  ${gray(note)}` : ''}`.trimEnd()
}

/** Red for a major step, yellow for a minor one, green for a patch or an unknown one. */
const levelColor = (level: ReportRow['level']): ((text: string) => string) =>
  level === 'major' || level === 'premajor'
    ? red
    : level === 'minor' || level === 'preminor'
      ? yellow
      : green

/** `850ms`, `12.3s`, `2m 05s`. */
export const formatElapsed = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const seconds = Math.round(ms / 1000)
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`
}

const logger = new Logger()

export default logger
