import semver from 'semver'
import type { ReasonCode, UpdateResult } from '@/types'
import { formatAge } from './duration'

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
  /** Where it moves (or would): the target, else the version a hold judged, else `latest`. */
  to: string
  /** The step from `current` to `to`, which colors `to`; null when unknown. */
  level: UpdateResult['updateType']
  /** The reason, worded for the section it is in. */
  note?: string
  /** What a `latest` rule moved despite (license, deprecation, peers, engines), apart from the note. */
  warnings: string[]
  /** The catalog the spec is in: the write lands there, once for every manifest using it. */
  catalog?: string
}

interface ReportSection {
  outcome: Outcome
  rows: ReportRow[]
  /** Distinct package names in the section. */
  packages: number
  /** One line for the whole section, shown after its heading. */
  hint?: string
}

/** Code-unit order: unlike `localeCompare`, it needs no ICU collator. */
const byCodeUnit = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0

const byPath = (a: string, b: string) =>
  a === '.' ? -1 : b === '.' ? 1 : byCodeUnit(a, b)

/**
 * `to` split where it starts to differ from `current`, at a `.`: `1.4.0 →
 * 1.20.0` is `['1.', '20.0']`, so the report colors only what changes.
 * Everything is the changed part when the first segment differs, or when
 * `current` is no version (`missing`).
 */
export const splitAtChange = (
  current: string,
  to: string,
): [same: string, changed: string] => {
  const was = current.split('.')
  const now = to.split('.')
  let i = 0
  while (i < now.length - 1 && was[i] === now[i]) i++
  const same = now.slice(0, i).join('.')
  return [same ? `${same}.` : '', now.slice(i).join('.')]
}

const STEPS = ['patch', 'minor', 'major'] as const

/** The file the range hint names: where `beyondRange` goes. */
const CONFIG_FILE = '.always-up-to-date.json'

/**
 * The `beyondRange` level that lets each row past its range, said once for
 * the section, with where the setting goes: `"beyondRange": "major" in
 * .always-up-to-date.json would allow them`, or with several steps, how many
 * each level allows (levels include the smaller steps). It says "allow", not
 * "move": the report sees the plan's rows only, and the passes after the
 * policy (cooldown, peers, license, deprecation, engines) can still hold a
 * row the level lets through, which only a plan run at that level would show.
 */
const rangeHint = (rows: ReportRow[], packages: number): string | undefined => {
  const stepOf = new Map<string, number>()
  for (const row of rows) {
    const step = STEPS.indexOf(row.note as (typeof STEPS)[number])
    if (step < 0) return undefined
    stepOf.set(row.name, Math.max(step, stepOf.get(row.name) ?? 0))
  }
  const steps = [...new Set(stepOf.values())].sort((a, b) => a - b)
  if (steps.length === 1) {
    return `"beyondRange": "${STEPS[steps[0]]}" in ${CONFIG_FILE} would allow ${packages === 1 ? 'it' : 'them'}`
  }
  const allowed = (step: number) =>
    [...stepOf.values()].filter((s) => s <= step).length
  return `"beyondRange" in ${CONFIG_FILE}: ${steps
    .map((step, i) =>
      i === 0
        ? `"${STEPS[step]}" would allow ${allowed(step)}`
        : i === steps.length - 1
          ? `"${STEPS[step]}" all ${packages}`
          : `"${STEPS[step]}" ${allowed(step)}`,
    )
    .join(', ')}`
}

/** An age a reason message gave in whole days, as the report shows it: years past 365. */
const yearsFor = (days: string): string => formatAge(Number(days))

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
      const what =
        result.catalog === undefined ? 'its range' : 'its catalog entry'
      const notes = [
        within
          ? undefined
          : phase === 'plan'
            ? `rewrites ${what}`
            : what === 'its range'
              ? 'range rewritten'
              : 'catalog entry rewritten',
        // A cooldown fallback (#147) names the newer version it held, by its
        // age: the row's own "released … ago" is the version that moves.
        result.reason.code === 'cooldown-fallback'
          ? reason
              .replace(/^cooldown: (\S+) (.*)$/, '$1 held by cooldown ($2)')
              .replace(/released (\S+) ago/, '$1 old')
              .replace(/(\d+)d old/, (_, days) => `${yearsFor(days)} old`)
              .replace(/requires /, 'needs ')
          : undefined,
        // npm's engines preference (#200): the version the target needed Node for.
        result.reason.code === 'engines-fallback'
          ? reason.replace(/^engines: /, '')
          : undefined,
      ]
      return notes.filter(Boolean).join(NOTE_SEPARATOR) || undefined
    }
    case 'cooldown':
      return reason
        .replace(/^cooldown: /, '')
        .replace(
          /released (\d+)d ago/,
          (_, days) => `released ${yearsFor(days)} ago`,
        )
        .replace(/requires /, 'needs ')
    // The step alone: the section's hint names the level that would move it.
    case 'range':
      return reason.replace(/ beyond the range$/, '')
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
    // A hold that judged a version shows it, with its step (#221).
    const judged = result.target === undefined ? result.judged : undefined
    const to = result.target ?? judged ?? result.latest
    const note = noteFor(outcome, result, phase)
    // A `latest` rule's warnings, shown apart from the note.
    const warnings =
      outcome === 'update' ? (result.warnings ?? []).map((w) => w.message) : []
    const key = [
      result.name,
      result.current,
      to,
      note,
      result.catalog,
      ...warnings,
    ].join('\0')
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
        level:
          judged !== undefined &&
          semver.valid(result.current) &&
          semver.valid(judged)
            ? semver.diff(result.current, judged)
            : result.updateType,
        note,
        warnings,
        ...(result.catalog === undefined ? {} : { catalog: result.catalog }),
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
          byCodeUnit(a.name, b.name) ||
          byPath(a.workspaces[0] ?? '.', b.workspaces[0] ?? '.'),
      )
    const packages = new Set(sorted.map((row) => row.name)).size
    const hint = outcome === 'range' ? rangeHint(sorted, packages) : undefined
    return [{ outcome, rows: sorted, packages, ...(hint ? { hint } : {}) }]
  })
}
