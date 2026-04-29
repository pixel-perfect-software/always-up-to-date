import { blue, bold, gray, green, red, yellow } from 'colorette'
import type SemVer from 'semver'
import type { UpdateResult } from '@/types'
import { loadConfig } from './config'
import { formatAgeDays } from './duration'

const config = loadConfig()

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
}

export interface SkippedRow extends OutdatedRow {
  updateType: SemVer.ReleaseType | null
  reason?: string
}

class Logger {
  private quiet: boolean = config.silent

  setQuiet(quiet: boolean): void {
    this.quiet = quiet
  }

  info(message: string): void {
    if (!this.quiet) console.log(`${blue('ℹ')}  ${message}`)
  }

  success(message: string): void {
    if (!this.quiet) console.log(`${green('✓')}  ${green(message)}`)
  }

  warn(message: string): void {
    if (!this.quiet) console.log(`${yellow('!')}  ${yellow(message)}`)
  }

  error(message: string): void {
    if (!this.quiet) console.log(`${red('✗')}  ${red(message)}`)
  }

  /**
   * Quiet by default. Only prints when `debug: true` in the config.
   * Used for shell-out commands which are noisy for normal CLI use.
   */
  command(command: string): void {
    if (!this.quiet && config.debug) {
      console.log(`${gray('$')} ${gray(command)}`)
    }
  }

  workspace(manager: string): void {
    if (!this.quiet) {
      console.log(gray(`Detected ${manager} workspace.`))
    }
  }

  allUpToDate(): void {
    if (!this.quiet) {
      console.log(`\n${green('✓')}  ${green('All packages are up to date.')}`)
    }
  }

  /**
   * Header above the outdated-packages list. Only emits the
   * allow/deny legend when those lists are actually populated.
   */
  outdatedHeader(): void {
    if (this.quiet) return
    console.log(`\n${yellow('▲')}  ${bold('Outdated packages found')}`)

    const hasDeny = (config.updateDenylist?.length ?? 0) > 0
    const hasAllow = (config.updateAllowlist?.length ?? 0) > 0
    if (!hasDeny && !hasAllow) return

    if (hasDeny) {
      console.log(gray(`   ${red('Ignored')}  in updateDenylist`))
    }
    if (hasAllow) {
      console.log(gray(`   ${green('Allowed')}  in updateAllowlist`))
    }
  }

  packageGroupHeader(groupName: string): void {
    if (this.quiet) return
    const displayName =
      groupName === 'unscoped' ? 'Other packages' : `${groupName} packages`
    console.log(`\n${bold(displayName)}`)
  }

  /**
   * Print a column-aligned block of outdated packages.
   * Pads name and current-version columns based on the widest entry.
   */
  printOutdatedRows(rows: OutdatedRow[]): void {
    if (this.quiet || rows.length === 0) return
    const widths = computeWidths(rows)
    for (const row of rows) {
      console.log(formatRow(row, widths, undefined))
    }
  }

  updatingHeader(manager: string): void {
    if (this.quiet) return
    console.log(`\n${blue('↻')}  ${bold(`Updating packages with ${manager}`)}`)
  }

  /**
   * Print a column-aligned block of packages being updated.
   */
  printUpdatingRows(rows: OutdatedRow[]): void {
    if (this.quiet || rows.length === 0) return
    const widths = computeWidths(rows)
    for (const row of rows) {
      console.log(formatRow(row, widths, undefined))
    }
  }

  /**
   * Print a column-aligned block of skipped packages with reason.
   */
  printSkippedRows(rows: SkippedRow[]): void {
    if (this.quiet || rows.length === 0) return
    const widths = computeWidths(rows)
    for (const row of rows) {
      const note = row.reason ?? `${row.updateType} update skipped`
      console.log(formatRow(row, widths, note))
    }
  }

  starting(operation: string, manager: string): void {
    if (this.quiet) return
    console.log(`${blue('▸')}  ${operation} with ${bold(manager)}`)
  }

  clean(message: string): void {
    if (!this.quiet) console.log(message)
  }

  debug(message: string): void {
    if (!this.quiet && config.debug) {
      console.log(gray(`  ${message}`))
    }
  }

  /**
   * Multi-line scannable notice for the case where outdated packages exist
   * but the config skipped them all. Header + indented body lines.
   */
  noPackagesToUpdate(body: string[] | string): void {
    if (this.quiet) return
    const lines = Array.isArray(body) ? body : [body]
    console.log(`\n${yellow('!')}  ${bold('No packages to update')}`)
    for (const line of lines) {
      console.log(`   ${gray(line)}`)
    }
  }

  /**
   * Summarise packages held back by the cooldown gate.
   * No-op when nothing is gated.
   */
  cooldownSummary(results: UpdateResult[]): void {
    if (this.quiet) return
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
      `\n${blue('◷')}  ${bold(`${pluralize(gated.length, 'package')} held by cooldown`)}`,
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
  if (config.updateDenylist?.includes(row.name)) {
    line += `  ${red('[ignored]')}`
  } else if (config.updateAllowlist?.includes(row.name)) {
    line += `  ${green('[allowed]')}`
  }

  return line
}

const logger = new Logger()

export default logger
