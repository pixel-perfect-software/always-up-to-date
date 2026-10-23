import { blue, bold, cyan, gray, green, red, yellow } from 'colorette'
import type SemVer from 'semver'
import type { AlwaysUpToDateConfig, UpdateResult } from '@/types'
import { formatAgeDays } from './duration'

export const pluralize = (
  count: number,
  singular: string,
  plural?: string,
): string => `${count} ${count === 1 ? singular : (plural ?? `${singular}s`)}`

export interface OutdatedRow {
  name: string
  current: string
  latest: string
  releaseAge?: number
  note?: string
}

export interface SkippedRow extends OutdatedRow {
  updateType: SemVer.ReleaseType | null
  reason?: string
}

/** The config fields the logger reads. */
export type LoggerConfig = Partial<
  Pick<
    AlwaysUpToDateConfig,
    'debug' | 'silent' | 'updateAllowlist' | 'updateDenylist'
  >
>

/** The deprecated allow/deny lists, shown as tags and a legend. */
interface TagLists {
  allowlist: string[]
  denylist: string[]
}

class Logger {
  private quiet = false
  private debugEnabled = false
  private jsonOutput = false
  private tags: TagLists = { allowlist: [], denylist: [] }

  /**
   * Applies the loaded config. Until it is called, debug is off, output is
   * not quiet and no allow/deny tags show.
   */
  configure(config: LoggerConfig): void {
    this.quiet = config.silent ?? false
    this.debugEnabled = config.debug ?? false
    this.tags = {
      allowlist: config.updateAllowlist ?? [],
      denylist: config.updateDenylist ?? [],
    }
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
    if (this.jsonOutput) console.error(line)
    else console.log(line)
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

  workspace(manager: string): void {
    if (!this.muted) {
      console.log(`${blue('🏢')} ${blue(`Detected ${manager} workspace.`)}`)
    }
  }

  allUpToDate(): void {
    if (!this.muted) {
      console.log(`\n${green('🎉')} ${green('All packages are up to date.')}`)
    }
  }

  /**
   * Header above the outdated-packages list. Only emits the
   * allow/deny legend when those lists are actually populated.
   */
  outdatedHeader(): void {
    if (this.muted) return
    console.log(`\n${yellow('📈')} ${bold('Outdated packages found')}`)

    const hasDeny = this.tags.denylist.length > 0
    const hasAllow = this.tags.allowlist.length > 0
    if (!hasDeny && !hasAllow) return

    if (hasDeny) {
      console.log(gray(`   ${red('Ignored')}  in updateDenylist`))
    }
    if (hasAllow) {
      console.log(gray(`   ${green('Allowed')}  in updateAllowlist`))
    }
  }

  packageGroupHeader(groupName: string): void {
    if (this.muted) return
    const displayName =
      groupName === 'unscoped' ? 'Other packages' : `${groupName} packages`
    console.log(`\n${cyan('🏷️')}  ${bold(cyan(displayName))}`)
  }

  /**
   * Print a column-aligned block of outdated packages.
   * Pads name and current-version columns based on the widest entry.
   */
  printOutdatedRows(rows: OutdatedRow[]): void {
    if (this.muted || rows.length === 0) return
    const widths = computeWidths(rows)
    for (const row of rows) {
      console.log(formatRow(row, widths, row.note, this.tags))
    }
  }

  updatingHeader(manager: string): void {
    if (this.muted) return
    console.log(`\n${blue('🔄')} ${bold(`Updating packages with ${manager}`)}`)
  }

  /**
   * Print a column-aligned block of packages being updated.
   */
  printUpdatingRows(rows: OutdatedRow[]): void {
    if (this.muted || rows.length === 0) return
    const widths = computeWidths(rows)
    for (const row of rows) {
      console.log(formatRow(row, widths, row.note, this.tags))
    }
  }

  /**
   * Print a column-aligned block of skipped packages with reason.
   */
  printSkippedRows(rows: SkippedRow[]): void {
    if (this.muted || rows.length === 0) return
    const widths = computeWidths(rows)
    for (const row of rows) {
      const note = row.reason ?? `${row.updateType} update skipped`
      console.log(formatRow(row, widths, note, this.tags))
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

  /**
   * Multi-line scannable notice for the case where outdated packages exist
   * but the config skipped them all. Header + indented body lines.
   */
  noPackagesToUpdate(body: string[] | string): void {
    if (this.muted) return
    const lines = Array.isArray(body) ? body : [body]
    console.log(`\n${yellow('🤔')} ${bold('No packages to update')}`)
    for (const line of lines) {
      console.log(`   ${gray(line)}`)
    }
  }

  /**
   * Packages the manager was asked to move but left in place (`not applied
   * by …` rows from `checkApplied`). No-op when every package moved.
   */
  notAppliedSummary(results: UpdateResult[], manager: string): void {
    if (this.muted) return
    const declined = results
      .filter((r) => !r.updated && r.reason?.startsWith('not applied by '))
      .map(
        (r): SkippedRow => ({
          name: r.name,
          current: r.current,
          latest: r.latest,
          updateType: r.updateType,
          reason: r.reason,
        }),
      )
    if (declined.length === 0) return
    console.log(
      `\n${yellow('⚠️')} ${bold(`${pluralize(declined.length, 'package')} left in place by ${manager}`)}`,
    )
    this.printSkippedRows(declined)
  }

  /**
   * Summarise packages held back by the cooldown gate.
   * No-op when nothing is gated.
   */
  cooldownSummary(results: UpdateResult[]): void {
    if (this.muted) return
    const gated = results
      .filter((r) => !r.updated && r.reason?.startsWith('cooldown:'))
      .map(
        (r): SkippedRow => ({
          name: r.name,
          current: r.current,
          latest: r.latest,
          updateType: r.updateType,
          reason: r.reason,
        }),
      )
    if (gated.length === 0) return
    console.log(
      `\n${blue('⏰')} ${bold(`${pluralize(gated.length, 'package')} held by cooldown`)}`,
    )
    this.printSkippedRows(gated)
  }
}

interface ColumnWidths {
  name: number
  current: number
  latest: number
}

const computeWidths = (rows: OutdatedRow[]): ColumnWidths => ({
  name: Math.max(...rows.map((r) => r.name.length)),
  current: Math.max(...rows.map((r) => r.current.length)),
  latest: Math.max(...rows.map((r) => r.latest.length)),
})

const formatRow = (
  row: OutdatedRow,
  widths: ColumnWidths,
  trailingNote: string | undefined,
  tags: TagLists,
): string => {
  const name = bold(row.name.padEnd(widths.name))
  const current = red(row.current.padEnd(widths.current))
  const latest = green(row.latest.padEnd(widths.latest))
  const arrow = gray('→')
  let line = `  ${name}  ${current} ${arrow} ${latest}`

  const tail: string[] = []
  if (row.releaseAge !== undefined) {
    tail.push(`released ${formatAgeDays(row.releaseAge)} ago`)
  }
  if (trailingNote) tail.push(trailingNote)
  if (tail.length > 0) line += `  ${gray(`(${tail.join(' · ')})`)}`

  // Indicate allow/deny decoration as a tag on the right
  if (tags.denylist.includes(row.name)) {
    line += `  ${red('[ignored]')}`
  } else if (tags.allowlist.includes(row.name)) {
    line += `  ${green('[allowed]')}`
  }

  return line
}

const logger = new Logger()

export default logger
