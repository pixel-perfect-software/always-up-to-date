import {
  type BenchDocument,
  type MeasuredRow,
  medianDifference,
  parseBenchDocument,
  renderTable,
  type Timing,
} from './report'
import { TARGETS, type Target } from './targets'

// Pure: no file, process, clock or child process in this module. `gate.ts`
// holds the effects and hands text in.

/** The legs of the gate: one per manager target, and `startup`, which needs no manager. */
export const LEGS = ['startup', ...TARGETS] as const
export type Leg = (typeof LEGS)[number]

/** `AUTD_BENCH_GATE_TARGET`: a target or `startup`. Unset, blank or unknown throws before anything is measured. */
export const legFrom = (value: string | undefined): Leg => {
  const leg = value?.trim()
  const found = LEGS.find((name) => name === leg)
  if (found === undefined) {
    throw new Error(
      leg === undefined || leg === ''
        ? `AUTD_BENCH_GATE_TARGET is not set; use ${LEGS.join(', ')}`
        : `AUTD_BENCH_GATE_TARGET: unknown target ${leg}; use ${LEGS.join(', ')}`,
    )
  }
  return found
}

export type BudgetId = 'cold' | 'warm' | 'cooldown' | 'startup'

export type Budget = {
  id: BudgetId
  name: string
  /** Seconds. A value must be strictly under it. */
  limit: number
  /** The value is a difference, shown with its sign. */
  signed: boolean
}

/** What #110 promises. No margin: the documented number is the number enforced. */
export const BUDGETS: readonly Budget[] = [
  { id: 'cold', name: '`check`, cold', limit: 1, signed: false },
  { id: 'warm', name: '`check`, warm', limit: 0.3, signed: false },
  {
    id: 'cooldown',
    name: 'Cooldown overhead, cold',
    limit: 0.5,
    signed: true,
  },
  { id: 'startup', name: 'Startup over bare node', limit: 0.025, signed: true },
]

/** The budgets one leg measures. */
export const budgetsFor = (leg: Leg): Budget[] =>
  BUDGETS.filter((budget) =>
    leg === 'startup' ? budget.id === 'startup' : budget.id !== 'startup',
  )

/** At most this many bench runs per leg. */
export const MAX_ATTEMPTS = 3
/** Seconds to wait before measuring again after a first reading over a budget, or after a failure. */
export const CONFIRM_WAIT = 30
/** Seconds to wait after the first and the second throttled attempt. */
export const THROTTLE_WAITS: readonly number[] = [60, 120]
/** A median of fewer runs is not one: two runs make it the mean. */
export const MIN_RUNS = 3

export type AttemptInfo = {
  autd: string
  node: string
  platform: string
  arch: string
  /** The manager row's label (`npm 11.19.1`), absent for startup. */
  label?: string
  /** Timings shown, not budgeted. */
  notBudgeted: { name: string; seconds: number }[]
  /** `Medians of 3 cold and 5 warm runs.` */
  runs: string
  fullPackuments?: string[]
}

export type Attempt =
  | {
      status: 'measured'
      values: Partial<Record<BudgetId, number>>
      info: AttemptInfo
    }
  | { status: 'throttled' | 'failed'; error: string }

const failed = (error: string): Attempt => ({ status: 'failed', error })

const tooFewRuns = (timings: [string, Timing][]): string | undefined => {
  const short = timings.find(([, timing]) => timing.runs < MIN_RUNS)
  return short === undefined
    ? undefined
    : `${short[0]} has ${short[1].runs} runs: at least ${MIN_RUNS} are needed for a median`
}

const rowAttempt = (document: BenchDocument, leg: Target): Attempt => {
  const row = document.rows.find((candidate) => candidate.target === leg)
  if (row === undefined) return failed(`the bench document has no ${leg} row`)
  if (row.status !== 'measured') {
    return { status: row.status, error: row.error }
  }
  const measured: MeasuredRow = row
  const short = tooFewRuns([
    ['check, warm', measured.warm],
    ['check, cold', measured.cold],
    ['moving, cold', measured.moving],
    ['cooldown 7, cold', measured.cooldownCold],
    ['cooldown 7, warm', measured.cooldownWarm],
  ])
  if (short !== undefined) return failed(short)
  return {
    status: 'measured',
    values: {
      cold: measured.cold.median,
      warm: measured.warm.median,
      cooldown: medianDifference(measured.cooldownCold, measured.moving),
    },
    info: {
      autd: document.autd,
      node: document.node,
      platform: document.platform,
      arch: document.arch,
      label: measured.label,
      notBudgeted: [
        { name: 'moving, cold', seconds: measured.moving.median },
        { name: 'cooldown 7, warm', seconds: measured.cooldownWarm.median },
      ],
      runs: `Medians of ${measured.cold.runs} cold and ${measured.warm.runs} warm runs.`,
      ...(measured.fullPackuments === undefined
        ? {}
        : { fullPackuments: measured.fullPackuments }),
    },
  }
}

const startupAttempt = (document: BenchDocument): Attempt => {
  const startup = document.startup
  if (startup === undefined) {
    return failed('the bench document has no startup measurement')
  }
  if (startup.status === 'failed') {
    return { status: 'failed', error: startup.error }
  }
  const short = tooFewRuns([
    ['autd --version', startup.version],
    ['node -e 0', startup.bare],
  ])
  if (short !== undefined) return failed(short)
  return {
    status: 'measured',
    values: { startup: medianDifference(startup.version, startup.bare) },
    info: {
      autd: document.autd,
      node: document.node,
      platform: document.platform,
      arch: document.arch,
      notBudgeted: [
        { name: '`autd --version`', seconds: startup.version.median },
        { name: '`node -e 0`', seconds: startup.bare.median },
      ],
      runs: `Medians of ${startup.version.runs} runs of each command.`,
    },
  }
}

/**
 * What one bench run measured for `leg`, from the text of its document
 * (`undefined` when none was written). It fails closed: a missing or
 * unparseable document, a missing row or startup result, or a timing with
 * fewer than `MIN_RUNS` runs is `failed`.
 */
export const attemptOf = (text: string | undefined, leg: Leg): Attempt => {
  if (text === undefined) return failed('the bench wrote no document')
  let document: BenchDocument
  try {
    document = parseBenchDocument(text)
  } catch (error) {
    return failed(error instanceof Error ? error.message : String(error))
  }
  return leg === 'startup'
    ? startupAttempt(document)
    : rowAttempt(document, leg)
}

export type BudgetResult = {
  budget: Budget
  /** One per attempt; `undefined` where the attempt measured nothing. */
  readings: (number | undefined)[]
  /** The lower of the readings: `verdictOf` decides whether an over one was confirmed. */
  best: number | undefined
  /** Strict: a value equal to the limit is over. */
  over: boolean
  /** Seconds past the limit, when over. */
  excess?: number
}

export const resultsOf = (
  attempts: readonly Attempt[],
  budgets: readonly Budget[],
): BudgetResult[] =>
  budgets.map((budget) => {
    const readings = attempts.map((attempt) =>
      attempt.status === 'measured' ? attempt.values[budget.id] : undefined,
    )
    const measured = readings.filter(
      (reading): reading is number => reading !== undefined,
    )
    const best = measured.length === 0 ? undefined : Math.min(...measured)
    const over = best !== undefined && best >= budget.limit
    return {
      budget,
      readings,
      best,
      over,
      ...(over && best !== undefined ? { excess: best - budget.limit } : {}),
    }
  })

export type Step = { done: true } | { done: false; waitSeconds: number }

/**
 * What to do after the attempts so far. Measured and all under: done. Measured
 * and over: measure again after 30 s, once; the second measured reading ends
 * it. Throttled: wait 60 s, then 120 s. Failed: one retry after 30 s. Never
 * more than `MAX_ATTEMPTS` runs.
 */
export const nextStep = (
  attempts: readonly Attempt[],
  budgets: readonly Budget[],
): Step => {
  const last = attempts.at(-1)
  if (last === undefined) return { done: false, waitSeconds: 0 }
  if (attempts.length >= MAX_ATTEMPTS) return { done: true }

  const count = (status: Attempt['status']): number =>
    attempts.filter((attempt) => attempt.status === status).length

  if (last.status === 'measured') {
    if (!resultsOf(attempts, budgets).some((result) => result.over)) {
      return { done: true }
    }
    return count('measured') >= 2
      ? { done: true }
      : { done: false, waitSeconds: CONFIRM_WAIT }
  }
  if (last.status === 'throttled') {
    return {
      done: false,
      waitSeconds: THROTTLE_WAITS[Math.min(count('throttled'), 2) - 1],
    }
  }
  return count('failed') >= 2
    ? { done: true }
    : { done: false, waitSeconds: CONFIRM_WAIT }
}

export type Verdict = 'passed' | 'over' | 'throttled' | 'failed'

/**
 * The outcome once the attempts stop. The latest attempt decides between
 * throttled and failed; a measured one is judged on the lower reading of each
 * budget across the measured attempts. A throttled attempt never confirms a
 * reading, whichever order it came in: one over reading that throttling left
 * unconfirmed is inconclusive, not over budget.
 */
export const verdictOf = (
  attempts: readonly Attempt[],
  budgets: readonly Budget[],
): Verdict => {
  const last = attempts.at(-1)
  if (last === undefined || last.status === 'failed') return 'failed'
  if (last.status === 'throttled') return 'throttled'
  if (!resultsOf(attempts, budgets).some((result) => result.over)) {
    return 'passed'
  }
  const unconfirmed =
    attempts.filter((attempt) => attempt.status === 'measured').length < 2 &&
    attempts.some((attempt) => attempt.status === 'throttled')
  return unconfirmed ? 'throttled' : 'over'
}

/** 0 passed, 1 over budget, 2 failed, 3 throttled and inconclusive. */
export const exitCodeOf = (verdict: Verdict): 0 | 1 | 2 | 3 =>
  ({ passed: 0, over: 1, failed: 2, throttled: 3 })[verdict] as 0 | 1 | 2 | 3

/**
 * Seconds as the summary shows them: below 0.1 s in milliseconds with one
 * decimal (24.6 ms, never "25 ms"), else seconds with two (one from 10 s).
 * `signed` puts a `+` or `-` in front.
 */
export const formatAmount = (seconds: number, signed = false): string => {
  const size = Math.abs(seconds)
  const milliseconds = (size * 1000).toFixed(1)
  // 99.96 ms rounds to "100.0 ms": that is 0.10 s.
  const text =
    size < 0.1 && milliseconds !== '100.0'
      ? `${milliseconds} ms`
      : `${size.toFixed(size < 10 ? 2 : 1)} s`
  if (!signed) return seconds < 0 ? `-${text}` : text
  return `${seconds < 0 && /[1-9]/.test(text) ? '-' : '+'}${text}`
}

/** A limit without trailing zeros: `1 s`, `0.3 s`, `25 ms`. */
const formatLimit = (seconds: number): string =>
  seconds < 0.1
    ? `${Number((seconds * 1000).toFixed(1))} ms`
    : `${Number(seconds.toFixed(2))} s`

const percentOf = (excess: number, limit: number): string => {
  const percent = (excess / limit) * 100
  return percent > 0 && percent < 1 ? '<1%' : `${Math.round(percent)}%`
}

const overBy = (result: BudgetResult): string =>
  `over by ${formatAmount(result.excess ?? 0)} (${percentOf(result.excess ?? 0, result.budget.limit)})`

/** One line a workflow command can safely carry: `%`, CR and LF escaped as GitHub documents. */
const escapeData = (text: string): string =>
  text.replaceAll('%', '%25').replaceAll('\r', '%0D').replaceAll('\n', '%0A')

const escapeProperty = (text: string): string =>
  escapeData(text).replaceAll(':', '%3A').replaceAll(',', '%2C')

const strip = (name: string): string => name.replaceAll('`', '')

const readingOf = (budget: Budget, reading: number | undefined): string =>
  reading === undefined ? 'not measured' : formatAmount(reading, budget.signed)

/**
 * The workflow commands for a verdict: one `::error` per confirmed breach (the
 * lower reading, with the limit and the excess), one `::warning` for a
 * throttled leg, one `::error` for a failed one. Only our own names and numbers
 * go in: never a row's error text, which comes from outside.
 */
export const annotationsOf = (
  leg: Leg,
  attempts: readonly Attempt[],
  budgets: readonly Budget[],
): string[] => {
  const title = escapeProperty(`perf (${leg})`)
  const verdict = verdictOf(attempts, budgets)
  if (verdict === 'over') {
    return resultsOf(attempts, budgets)
      .filter((result) => result.over && result.best !== undefined)
      .map(
        (result) =>
          `::error title=${title}::${escapeData(
            `${strip(result.budget.name)}: ${readingOf(result.budget, result.best)} against a limit of ${formatLimit(result.budget.limit)}, ${overBy(result)}`,
          )}`,
      )
  }
  if (verdict === 'throttled') {
    return [
      `::warning title=${title}::${escapeData(
        `throttled after ${attempts.length} attempts: not a budget failure; re-run the failed job`,
      )}`,
    ]
  }
  if (verdict === 'failed') {
    return [
      `::error title=${title}::${escapeData(
        `the measurement failed after ${attempts.length} attempt${attempts.length === 1 ? '' : 's'}; see the job summary`,
      )}`,
    ]
  }
  return []
}

const HEADINGS: Record<Verdict, string> = {
  passed: 'passed',
  over: 'over budget',
  throttled: 'throttled, not a budget failure',
  failed: 'failed',
}

const ERROR_LINES = 20
const LINE_LENGTH = 400

/**
 * A row's error text in a fenced block, cut to 20 lines. The text comes from
 * outside (a manager's output), so the fence is longer than any run of
 * backticks in it, and a line that would read as a workflow command
 * (`::…`, `##[…`) gets a backslash in front.
 */
const errorBlock = (text: string): string => {
  const lines = text
    .trimEnd()
    .split(/\r?\n/)
    .map((line) =>
      (line.length > LINE_LENGTH
        ? `${line.slice(0, LINE_LENGTH)}…`
        : line
      ).replace(/^(\s*)(::|##\[)/, '$1\\$2'),
    )
  const shown = lines.slice(0, ERROR_LINES)
  const cut = lines.length - shown.length
  const longest = Math.max(
    0,
    ...(shown.join('\n').match(/`+/g) ?? []).map((run) => run.length),
  )
  const fence = '`'.repeat(Math.max(3, longest + 1))
  return [
    fence,
    ...shown,
    ...(cut > 0 ? [`… ${cut} more line${cut === 1 ? '' : 's'} cut`] : []),
    fence,
  ].join('\n')
}

/**
 * The job summary of one leg: the verdict, a table of each budget with its
 * limit, every attempt's value and the result, what else was measured, and
 * the error text of each attempt that measured nothing.
 */
export const renderSummary = (
  leg: Leg,
  attempts: readonly Attempt[],
  budgets: readonly Budget[],
): string => {
  const verdict = verdictOf(attempts, budgets)
  const results = resultsOf(attempts, budgets)
  const measured = attempts.filter(
    (attempt): attempt is Extract<Attempt, { status: 'measured' }> =>
      attempt.status === 'measured',
  )
  const lines: string[] = [`## perf (${leg}): ${HEADINGS[verdict]}`, '']

  if (verdict === 'throttled') {
    lines.push(
      measured.length === 0
        ? `The registry throttled the run on ${attempts.length} attempts, so nothing was measured. This is not a budget failure: use Re-run failed jobs.`
        : `The registry throttled ${attempts.filter((attempt) => attempt.status === 'throttled').length} of ${attempts.length} attempts, and ${measured.length} of ${attempts.length} attempts measured. A throttled attempt confirms nothing, so this is not a budget failure: use Re-run failed jobs.`,
      '',
    )
  } else if (verdict === 'failed') {
    lines.push(
      `The measurement failed on ${attempts.filter((attempt) => attempt.status === 'failed').length} of ${attempts.length} attempts. The error text is below.`,
      '',
    )
  }

  const header = [
    'Budget',
    'Limit',
    ...attempts.map((_, index) => `Attempt ${index + 1}`),
    'Result',
  ]
  const rows = results.map((result) => {
    const { budget } = result
    let outcome: string
    if (result.best === undefined) {
      outcome = 'not measured'
    } else if (result.over) {
      outcome =
        verdict === 'over' ? overBy(result) : `${overBy(result)}, not confirmed`
    } else {
      const overOn = result.readings
        .map((reading, index) =>
          reading !== undefined && reading >= budget.limit ? index + 1 : 0,
        )
        .filter((index) => index > 0)
      outcome =
        overOn.length === 0
          ? 'ok'
          : `ok (over on attempt ${overOn.join(', ')} only)`
    }
    return [
      budget.name,
      formatLimit(budget.limit),
      ...result.readings.map((reading, index) => {
        const attempt = attempts[index]
        return attempt.status === 'measured'
          ? readingOf(budget, reading)
          : attempt.status
      }),
      outcome,
    ]
  })
  lines.push(renderTable(header, rows), '')

  lines.push(
    'A budget fails only if it is over on two measured attempts: the lower reading counts, and a value equal to the limit is over.',
  )

  const info = measured.at(-1)?.info
  if (info !== undefined) {
    lines.push(
      `Not budgeted: ${info.notBudgeted
        .map((entry) => `${strip(entry.name)} ${formatAmount(entry.seconds)}`)
        .join('; ')}. ${info.runs}`,
    )
    if (info.fullPackuments !== undefined) {
      lines.push(
        `Full packuments read: ${info.fullPackuments.length === 0 ? 'none' : info.fullPackuments.join(', ')}.`,
      )
    }
    lines.push(
      `${info.label === undefined ? '' : `${info.label}, `}autd ${info.autd}, Node ${info.node}, ${info.platform} ${info.arch}.`,
    )
  }

  attempts.forEach((attempt, index) => {
    if (attempt.status === 'measured') return
    lines.push(
      '',
      `Attempt ${index + 1} ${attempt.status}:`,
      '',
      errorBlock(attempt.error),
    )
  })

  return `${lines.join('\n')}\n`
}
