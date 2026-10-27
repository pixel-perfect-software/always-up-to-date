import semver from 'semver'
import type { UpdateResult } from '@/types'

/** What happened to one candidate, or will. */
export type Outcome =
  | 'update'
  | 'not-applied'
  | 'cooldown'
  | 'range'
  | 'rule'
  | 'override'
  | 'peer'
  | 'together'
  | 'other'

/** Report order: what moves first, then the holds a user can change in the config. */
const ORDER: Outcome[] = [
  'update',
  'not-applied',
  'cooldown',
  'range',
  'rule',
  'override',
  'peer',
  'together',
  'other',
]

/** Untargeted rows (`autd update a b`) are left out of the report. */
export const outcomeOf = (result: UpdateResult): Outcome | undefined => {
  if (result.updated) return 'update'
  const reason = result.reason ?? ''
  if (reason === 'not targeted') return undefined
  if (reason.startsWith('not applied by ')) return 'not-applied'
  if (reason.startsWith('cooldown:')) return 'cooldown'
  if (reason.endsWith(' beyond the range')) return 'range'
  if (reason === 'held by rule' || reason.endsWith('(rule followRange)')) {
    return 'rule'
  }
  if (reason.startsWith('controlled by ')) return 'override'
  if (reason.startsWith('peer conflict: ')) return 'peer'
  if (reason.startsWith('held with ')) return 'together'
  return 'other'
}

/** One line of the report: a package and every manifest that shares its move and reason. */
export interface ReportRow {
  name: string
  /** Manifest paths ('.' is the root), sorted; empty in a single-package project. */
  workspaces: string[]
  current: string
  /** Where it moves (or would): the target, else `latest`. */
  to: string
  /** The reason, worded for the section it is in. */
  note?: string
}

export interface ReportSection {
  outcome: Outcome
  rows: ReportRow[]
  /** Distinct package names in the section. */
  packages: number
}

const byPath = (a: string, b: string) =>
  a === '.' ? -1 : b === '.' ? 1 : a.localeCompare(b)

/** The reason as the section shows it: the section names the kind of hold. */
const noteFor = (
  outcome: Outcome,
  result: UpdateResult,
): string | undefined => {
  const reason = result.reason ?? ''
  switch (outcome) {
    case 'update': {
      const { target = '', wanted } = result
      const within =
        target === wanted ||
        (semver.valid(target) !== null &&
          semver.valid(wanted) !== null &&
          semver.lt(target, wanted))
      const notes = [
        within ? 'within range' : 'past its range',
        // A cooldown fallback (#147) names the newer version it held.
        reason.startsWith('cooldown: ')
          ? reason.replace(/^cooldown: /, '').replace(/requires /, 'needs ')
          : undefined,
        result.warning,
      ]
      return notes.filter(Boolean).join('; ')
    }
    case 'cooldown':
      return reason.replace(/^cooldown: /, '').replace(/requires /, 'needs ')
    case 'range': {
      const step = reason.replace(/ beyond the range$/, '')
      return `${step}; "beyondRange": "${step}" would move it`
    }
    case 'rule':
      return reason === 'held by rule' ? 'rule "hold"' : 'rule "followRange"'
    case 'not-applied':
      return reason.replace(/^not applied by \S+ \((.*)\)$/, '$1')
    default:
      return reason || undefined
  }
}

/**
 * The results grouped by outcome, in report order, each candidate once. Rows
 * that share a package, versions and reason across manifests are one row.
 */
export const groupResults = (results: UpdateResult[]): ReportSection[] => {
  const sections = new Map<Outcome, Map<string, ReportRow>>()
  for (const result of results) {
    const outcome = outcomeOf(result)
    if (!outcome) continue
    const to = result.target ?? result.latest
    const note = noteFor(outcome, result)
    const key = [result.name, result.current, to, note].join('\0')
    let rows = sections.get(outcome)
    if (!rows) {
      rows = new Map()
      sections.set(outcome, rows)
    }
    const row = rows.get(key)
    if (row) {
      if (result.workspace !== undefined) row.workspaces.push(result.workspace)
    } else {
      rows.set(key, {
        name: result.name,
        workspaces: result.workspace === undefined ? [] : [result.workspace],
        current: result.current,
        to,
        note,
      })
    }
  }
  return ORDER.flatMap((outcome) => {
    const rows = sections.get(outcome)
    if (!rows) return []
    const sorted = [...rows.values()]
      .map((row) => ({ ...row, workspaces: row.workspaces.sort(byPath) }))
      .sort(
        (a, b) =>
          a.name.localeCompare(b.name) ||
          byPath(a.workspaces[0] ?? '.', b.workspaces[0] ?? '.'),
      )
    return [
      {
        outcome,
        rows: sorted,
        packages: new Set(sorted.map((row) => row.name)).size,
      },
    ]
  })
}
