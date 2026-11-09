import semver from 'semver'
import type { ReasonCode, UpdateResult } from '@/types'

/** Before apply (`check`, `--dry-run`, interactive) or after it. */
export type ReportPhase = 'plan' | 'applied'

/** What happened to one candidate, or will. */
export type Outcome =
  | 'update'
  | 'not-applied'
  | 'cooldown'
  | 'range'
  | 'rule'
  | 'override'
  | 'peer'
  | 'deprecated'
  | 'license'
  | 'engines'
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
  'deprecated',
  'license',
  'engines',
  'together',
  'other',
]

/** The report section of each reason code; a new code must get one here. */
export const SECTION_OF: Record<ReasonCode, Outcome | undefined> = {
  'within-range': 'update',
  'past-range': 'update',
  'rule-latest': 'update',
  'cooldown-fallback': 'update',
  'engines-fallback': 'update',
  'invalid-version': 'other',
  'not-installed': 'other',
  'not-newer': 'other',
  'rule-hold': 'rule',
  'rule-follow-range': 'rule',
  'outside-range': 'range',
  override: 'override',
  'peer-conflict': 'peer',
  'target-peers': 'peer',
  cooldown: 'cooldown',
  deprecated: 'deprecated',
  'license-change': 'license',
  engines: 'engines',
  'held-with': 'together',
  'not-applied': 'not-applied',
  'not-targeted': undefined,
}

/** Untargeted rows (`autd update a b`) are left out of the report. */
export const outcomeOf = (result: UpdateResult): Outcome | undefined =>
  result.updated ? 'update' : SECTION_OF[result.reason.code]

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

/** The notes of one row, as the report joins them. */
export const NOTE_SEPARATOR = ' · '

/**
 * The reason as the section shows it: the section names the kind of hold. A
 * move within the range has no note of its own, since it is the default; a
 * move past it rewrites the manifest's range, which the note says in the
 * phase's tense.
 */
const noteFor = (
  outcome: Outcome,
  result: UpdateResult,
  phase: ReportPhase,
): string | undefined => {
  const reason = result.reason.message
  switch (outcome) {
    case 'update': {
      const { target = '', wanted } = result
      const within =
        target === wanted ||
        (semver.valid(target) !== null &&
          semver.valid(wanted) !== null &&
          semver.lt(target, wanted))
      const notes = [
        within
          ? undefined
          : phase === 'plan'
            ? 'rewrites its range'
            : 'range rewritten',
        // A cooldown fallback (#147) names the newer version it held.
        result.reason.code === 'cooldown-fallback'
          ? reason
              .replace(/^cooldown: (\S+) (.*)$/, '$1 held by cooldown ($2)')
              .replace(/requires /, 'needs ')
          : undefined,
        // npm's engines preference (#200): the version the target needed Node for.
        result.reason.code === 'engines-fallback'
          ? reason.replace(/^engines: /, '')
          : undefined,
        ...(result.warnings ?? []).map((w) => w.message),
      ]
      return notes.filter(Boolean).join(NOTE_SEPARATOR) || undefined
    }
    case 'cooldown':
      return reason.replace(/^cooldown: /, '').replace(/requires /, 'needs ')
    case 'range': {
      const step = reason.replace(/ beyond the range$/, '')
      return `${step}; "beyondRange": "${step}" would move it`
    }
    case 'rule':
      return result.reason.code === 'rule-hold'
        ? 'rule "hold"'
        : 'rule "followRange"'
    case 'deprecated':
      return reason.replace(/^deprecated: /, '')
    case 'license':
      return reason.replace(/^license change: /, '')
    case 'engines':
      return reason.replace(/^engines: /, '')
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
export const groupResults = (
  results: UpdateResult[],
  phase: ReportPhase = 'plan',
): ReportSection[] => {
  const sections = new Map<Outcome, Map<string, ReportRow>>()
  for (const result of results) {
    const outcome = outcomeOf(result)
    if (!outcome) continue
    const to = result.target ?? result.latest
    const note = noteFor(outcome, result, phase)
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
