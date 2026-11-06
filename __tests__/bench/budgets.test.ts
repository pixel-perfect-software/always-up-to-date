import {
  type Attempt,
  annotationsOf,
  attemptOf,
  BUDGETS,
  budgetsFor,
  exitCodeOf,
  formatAmount,
  type Leg,
  legFrom,
  nextStep,
  renderSummary,
  resultsOf,
  verdictOf,
} from '../../bench/budgets'
import { readFixture } from '../fixtures'

// The real capture (an npm row and a startup pair), with variants made by structuredClone.
// biome-ignore lint/suspicious/noExplicitAny: the tests overwrite and delete fields the real type requires
type Loose = Record<string, any>
const capture: Loose = JSON.parse(readFixture('bench/document.json'))

const documentWith = (edit: (document: Loose) => void): string => {
  const document = structuredClone(capture)
  edit(document)
  return JSON.stringify(document)
}

type Values = {
  cold?: number
  warm?: number
  /** cooldownCold.median minus moving.median */
  cooldown?: number
  /** version.median minus bare.median */
  startup?: number
}

/** A document whose medians give exactly these budget values; the rest stays as captured. */
const valuesDocument = (values: Values): string =>
  documentWith((document) => {
    const row = document.rows[0]
    if (values.cold !== undefined) row.cold.median = values.cold
    if (values.warm !== undefined) row.warm.median = values.warm
    if (values.cooldown !== undefined) {
      row.moving.median = 0.25
      row.cooldownCold.median = 0.25 + values.cooldown
    }
    if (values.startup !== undefined) {
      document.startup.bare.median = 0.025
      document.startup.version.median = 0.025 + values.startup
    }
  })

const row = (values: Values): Attempt =>
  attemptOf(valuesDocument(values), 'npm')
const startup = (value: number): Attempt =>
  attemptOf(valuesDocument({ startup: value }), 'startup')

const status = (kind: 'throttled' | 'failed', error = 'boom'): Attempt => ({
  status: kind,
  error,
})

const UNDER: Values = { cold: 0.5, warm: 0.1, cooldown: 0.1 }
const budgets = budgetsFor('npm')

const readings = (attempt: Attempt, leg: Leg = 'npm') =>
  attempt.status === 'measured' ? attempt.values : { leg }

describe('legFrom', () => {
  it('accepts startup and every target', () => {
    expect(legFrom('startup')).toBe('startup')
    expect(legFrom('berry-nm')).toBe('berry-nm')
    expect(legFrom(' bun ')).toBe('bun')
  })

  it.each([undefined, '', '  '])('refuses %j, naming the choices', (value) => {
    expect(() => legFrom(value)).toThrow(/not set; use startup, npm/)
  })

  it('refuses an unknown name before anything is measured', () => {
    expect(() => legFrom('deno')).toThrow(
      /unknown target deno; use startup, npm, pnpm, yarn, berry, berry-nm, bun/,
    )
  })
})

describe('budgets', () => {
  it('are the documented ones', () => {
    expect(BUDGETS.map((budget) => [budget.id, budget.limit])).toEqual([
      ['cold', 1],
      ['warm', 0.3],
      ['cooldown', 0.5],
      ['startup', 0.025],
    ])
  })

  it('belong to their leg: startup alone on the startup leg, the three others on a manager', () => {
    expect(budgetsFor('startup').map((budget) => budget.id)).toEqual([
      'startup',
    ])
    expect(budgetsFor('bun').map((budget) => budget.id)).toEqual([
      'cold',
      'warm',
      'cooldown',
    ])
  })
})

describe('attemptOf: the values compared', () => {
  it('reads the median of each timing, not the mean', () => {
    const attempt = attemptOf(readFixture('bench/document.json'), 'npm')

    expect(readings(attempt)).toEqual({
      cold: capture.rows[0].cold.median,
      warm: capture.rows[0].warm.median,
      cooldown:
        capture.rows[0].cooldownCold.median - capture.rows[0].moving.median,
    })
    expect(capture.rows[0].cold.median).not.toBe(capture.rows[0].cold.mean)
  })

  it('compares startup as the difference of two medians', () => {
    const attempt = attemptOf(readFixture('bench/document.json'), 'startup')

    expect(readings(attempt, 'startup')).toEqual({
      startup: capture.startup.version.median - capture.startup.bare.median,
    })
  })

  it('keeps a negative cooldown difference, and it passes', () => {
    const attempt = row({ ...UNDER, cooldown: -0.04 })

    expect(readings(attempt)).toMatchObject({
      cooldown: expect.closeTo(-0.04, 10),
    })
    expect(verdictOf([attempt], budgets)).toBe('passed')
  })

  it('keeps a negative startup difference, and it passes', () => {
    const attempt = startup(-0.003)

    expect(verdictOf([attempt], budgetsFor('startup'))).toBe('passed')
  })
})

describe.each([
  ['cold', 1, (value: number) => row({ ...UNDER, cold: value }), 'npm'],
  ['warm', 0.3, (value: number) => row({ ...UNDER, warm: value }), 'npm'],
  [
    'cooldown',
    0.5,
    (value: number) => row({ ...UNDER, cooldown: value }),
    'npm',
  ],
  ['startup', 0.025, startup, 'startup'],
] as const)('the %s budget at its limit %d', (_id, limit, make, leg) => {
  const forLeg = budgetsFor(leg)
  const verdict = (value: number) => verdictOf([make(value)], forLeg)

  it('passes below the limit', () => {
    expect(verdict(limit / 2)).toBe('passed')
  })

  it('is over at the limit: under is strict', () => {
    expect(verdict(limit)).toBe('over')
  })

  it('is over above the limit', () => {
    expect(verdict(limit * 1.5)).toBe('over')
  })

  it('names only itself as over', () => {
    const results = resultsOf([make(limit * 2)], forLeg)

    expect(results.filter((result) => result.over)).toHaveLength(1)
    expect(results.find((result) => result.over)?.budget.limit).toBe(limit)
  })
})

describe('attemptOf: it fails closed', () => {
  it('on no document', () => {
    expect(attemptOf(undefined, 'npm')).toMatchObject({
      status: 'failed',
      error: 'the bench wrote no document',
    })
  })

  it('on a document that is not JSON', () => {
    expect(attemptOf('{"version": 1,', 'npm')).toMatchObject({
      status: 'failed',
      error: 'bench document: not JSON',
    })
  })

  it('on a document the parser rejects, with the parser path', () => {
    const text = documentWith((document) => {
      delete document.rows[0].cold.median
    })

    expect(attemptOf(text, 'npm')).toMatchObject({
      status: 'failed',
      error: expect.stringContaining('rows[0].cold.median'),
    })
  })

  it('on a missing row', () => {
    expect(attemptOf(valuesDocument(UNDER), 'pnpm')).toMatchObject({
      status: 'failed',
      error: 'the bench document has no pnpm row',
    })
  })

  it('on a missing startup result', () => {
    const text = documentWith((document) => {
      delete document.startup
    })

    expect(attemptOf(text, 'startup')).toMatchObject({
      status: 'failed',
      error: 'the bench document has no startup measurement',
    })
  })

  it.each(['warm', 'cold', 'moving', 'cooldownCold', 'cooldownWarm'])(
    'on %s with two runs, which make a median no better than the mean',
    (name) => {
      const text = documentWith((document) => {
        document.rows[0][name].runs = 2
      })

      expect(attemptOf(text, 'npm')).toMatchObject({
        status: 'failed',
        error: expect.stringMatching(/has 2 runs: at least 3 are needed/),
      })
    },
  )

  it.each(['version', 'bare'])('on startup %s with two runs', (name) => {
    const text = documentWith((document) => {
      document.startup[name].runs = 2
    })

    expect(attemptOf(text, 'startup')).toMatchObject({ status: 'failed' })
  })

  it('accepts exactly three runs', () => {
    const text = documentWith((document) => {
      document.rows[0].warm.runs = 3
    })

    expect(attemptOf(text, 'npm').status).toBe('measured')
  })

  it('keeps a failed row failed and a throttled row throttled, with their error', () => {
    const failed = documentWith((document) => {
      document.rows[0] = { target: 'npm', status: 'failed', error: 'no net' }
    })
    const throttled = documentWith((document) => {
      document.rows[0] = {
        target: 'npm',
        status: 'throttled',
        error: 'Throttled by registry.npmjs.org',
      }
    })

    expect(attemptOf(failed, 'npm')).toEqual({
      status: 'failed',
      error: 'no net',
    })
    expect(attemptOf(throttled, 'npm')).toEqual({
      status: 'throttled',
      error: 'Throttled by registry.npmjs.org',
    })
  })

  it('keeps a failed startup failed, with its error', () => {
    const text = documentWith((document) => {
      document.startup = { status: 'failed', error: 'hyperfine died' }
    })

    expect(attemptOf(text, 'startup')).toEqual({
      status: 'failed',
      error: 'hyperfine died',
    })
  })
})

describe('the lower of the medians across measured attempts', () => {
  it('takes the lower reading of each budget', () => {
    const results = resultsOf(
      [row({ ...UNDER, cold: 1.42 }), row({ ...UNDER, cold: 1.38 })],
      budgets,
    )

    expect(results[0].best).toBe(1.38)
    expect(results[0].excess).toBeCloseTo(0.38, 10)
  })

  it('fails a budget over on both attempts', () => {
    const attempts = [
      row({ ...UNDER, cold: 1.42 }),
      row({ ...UNDER, cold: 1.1 }),
    ]

    expect(verdictOf(attempts, budgets)).toBe('over')
  })

  it('passes when the second attempt is under', () => {
    const attempts = [
      row({ ...UNDER, cold: 1.42 }),
      row({ ...UNDER, cold: 0.9 }),
    ]

    expect(verdictOf(attempts, budgets)).toBe('passed')
  })

  it('passes when different budgets are over on different attempts', () => {
    const attempts = [
      row({ ...UNDER, cold: 1.2 }),
      row({ ...UNDER, warm: 0.4 }),
    ]

    expect(verdictOf(attempts, budgets)).toBe('passed')
  })

  it('skips attempts that measured nothing', () => {
    const results = resultsOf(
      [row({ ...UNDER, cold: 1.2 }), status('throttled'), status('failed')],
      budgets,
    )

    expect(results[0].readings).toEqual([1.2, undefined, undefined])
    expect(results[0].best).toBe(1.2)
  })
})

describe('nextStep and verdictOf: the decision table', () => {
  const over = row({ ...UNDER, cold: 1.42 })
  const under = row(UNDER)

  const step = (...attempts: Attempt[]) => nextStep(attempts, budgets)
  const verdict = (...attempts: Attempt[]) => verdictOf(attempts, budgets)

  it('measured and all under: stop, pass', () => {
    expect(step(under)).toEqual({ done: true })
    expect(verdict(under)).toBe('passed')
  })

  it('measured, some over, the first measured attempt: wait 30 s and measure again', () => {
    expect(step(over)).toEqual({ done: false, waitSeconds: 30 })
  })

  it('over twice: stop, over budget', () => {
    expect(step(over, over)).toEqual({ done: true })
    expect(verdict(over, over)).toBe('over')
  })

  it('over, then under: stop, pass', () => {
    expect(step(over, under)).toEqual({ done: true })
    expect(verdict(over, under)).toBe('passed')
  })

  it('throttled: wait 60 s, then 120 s', () => {
    expect(step(status('throttled'))).toEqual({ done: false, waitSeconds: 60 })
    expect(step(status('throttled'), status('throttled'))).toEqual({
      done: false,
      waitSeconds: 120,
    })
  })

  it('throttled three times: stop, throttled and inconclusive', () => {
    const attempts = [
      status('throttled'),
      status('throttled'),
      status('throttled'),
    ]

    expect(nextStep(attempts, budgets)).toEqual({ done: true })
    expect(verdictOf(attempts, budgets)).toBe('throttled')
    expect(exitCodeOf(verdictOf(attempts, budgets))).toBe(3)
  })

  it('a throttled attempt does not confirm an over reading', () => {
    expect(step(over, status('throttled'))).toEqual({
      done: false,
      waitSeconds: 60,
    })
    const attempts = [over, status('throttled'), status('throttled')]
    expect(verdictOf(attempts, budgets)).toBe('throttled')
    expect(resultsOf(attempts, budgets)[0].best).toBe(1.42)
  })

  it.each([
    ['failed, throttled, over', [status('failed'), status('throttled'), over]],
    ['throttled, failed, over', [status('throttled'), status('failed'), over]],
    [
      'throttled, throttled, over',
      [status('throttled'), status('throttled'), over],
    ],
    [
      'over, throttled, throttled',
      [over, status('throttled'), status('throttled')],
    ],
  ])(
    'one over reading at the attempt limit stays unconfirmed: %s',
    (_label, attempts) => {
      expect(nextStep(attempts, budgets)).toEqual({ done: true })
      expect(verdictOf(attempts, budgets)).toBe('throttled')
      expect(exitCodeOf(verdictOf(attempts, budgets))).toBe(3)
    },
  )

  it('throttled, then over: still wait 30 s for a confirmation', () => {
    expect(step(status('throttled'), over)).toEqual({
      done: false,
      waitSeconds: 30,
    })
  })

  it('failed: one retry after 30 s', () => {
    expect(step(status('failed'))).toEqual({ done: false, waitSeconds: 30 })
  })

  it('failed twice: stop, failed', () => {
    const attempts = [status('failed'), status('failed')]

    expect(nextStep(attempts, budgets)).toEqual({ done: true })
    expect(verdictOf(attempts, budgets)).toBe('failed')
  })

  it('failed, then measured under: pass', () => {
    expect(verdict(status('failed'), under)).toBe('passed')
  })

  it('never more than three attempts', () => {
    expect(step(over, status('failed'), over)).toEqual({ done: true })
    expect(step(status('failed'), status('throttled'), over)).toEqual({
      done: true,
    })
  })

  it('the latest attempt decides between failed and throttled', () => {
    expect(verdict(status('throttled'), status('failed'))).toBe('failed')
    expect(verdict(status('failed'), status('throttled'))).toBe('throttled')
  })
})

describe('exitCodeOf', () => {
  it.each([
    ['passed', 0],
    ['over', 1],
    ['failed', 2],
    ['throttled', 3],
  ] as const)('%s is %d', (verdict, code) => {
    expect(exitCodeOf(verdict)).toBe(code)
  })
})

describe('formatAmount', () => {
  it('shows values under 0.1 s in milliseconds with one decimal', () => {
    expect(formatAmount(0.0246)).toBe('24.6 ms')
    expect(formatAmount(0.0246, true)).toBe('+24.6 ms')
    expect(formatAmount(0.0004, true)).toBe('+0.4 ms')
  })

  it('shows two decimals from 0.1 s and one from 10 s', () => {
    expect(formatAmount(0.38)).toBe('0.38 s')
    expect(formatAmount(1.4249)).toBe('1.42 s')
    expect(formatAmount(12.34)).toBe('12.3 s')
    expect(formatAmount(0.09996, true)).toBe('+0.10 s')
  })

  it('signs a negative difference and never prints -0', () => {
    expect(formatAmount(-0.0082, true)).toBe('-8.2 ms')
    expect(formatAmount(-0.00001, true)).toBe('+0.0 ms')
    expect(formatAmount(0.09, true)).toBe('+90.0 ms')
  })
})

describe('renderSummary', () => {
  const summary = (attempts: Attempt[], leg: Leg = 'npm') =>
    renderSummary(leg, attempts, budgetsFor(leg))

  it('names the budget, its limit, each attempt and how far over', () => {
    const text = summary([
      row({ ...UNDER, cold: 1.42 }),
      row({ ...UNDER, cold: 1.38 }),
    ])

    expect(text).toContain('## perf (npm): over budget')
    expect(text).toMatch(
      /\| Budget\s+\| Limit \| Attempt 1 \| Attempt 2 \|\s+Result \|/,
    )
    expect(text).toMatch(
      /`check`, cold\s+\|\s+1 s \|\s+1\.42 s \|\s+1\.38 s \| over by 0\.38 s \(38%\) \|/,
    )
    expect(text).toMatch(/`check`, warm\s+\|\s+0\.3 s \|.*\|\s+ok \|/)
    expect(text).toMatch(
      /Cooldown overhead, cold\s+\|\s+0\.5 s \|\s+\+0\.10 s \|/,
    )
  })

  it('shows 24.6 ms as 24.6 ms and the excess of 25.4 ms as 0.4 ms, never +0 ms', () => {
    const under = summary([startup(0.0246)], 'startup')
    const over = summary([startup(0.0254), startup(0.0254)], 'startup')

    expect(under).toContain('## perf (startup): passed')
    expect(under).toMatch(/\| 25 ms \|\s+\+24\.6 ms \|\s+ok \|/)
    expect(over).toContain('over by 0.4 ms (2%)')
    expect(over).not.toContain('+0 ms')
  })

  it('says a reading over on one attempt only, when the other was under', () => {
    const text = summary([
      row({ ...UNDER, cold: 1.2 }),
      row({ ...UNDER, warm: 0.4 }),
    ])

    expect(text).toContain('## perf (npm): passed')
    expect(text).toContain('ok (over on attempt 1 only)')
    expect(text).toContain('ok (over on attempt 2 only)')
  })

  it('lists what is not budgeted, the run counts, packuments and versions', () => {
    const text = summary([row(UNDER)])

    expect(text).toContain(
      'Not budgeted: moving, cold 0.25 s; cooldown 7, warm',
    )
    expect(text).toContain('Medians of 3 cold and 5 warm runs.')
    expect(text).toContain('Full packuments read: none.')
    expect(text).toContain(
      'npm 11.19.1, autd 3.4.0, Node 24.22.1, darwin arm64.',
    )
  })

  it('lists the packuments a run read in full', () => {
    const text = summary([
      attemptOf(
        documentWith((document) => {
          document.rows[0].fullPackuments = ['next', 'typescript']
        }),
        'npm',
      ),
    ])

    expect(text).toContain('Full packuments read: next, typescript.')
  })

  it('labels a leg throttled on every attempt as not a budget failure, with nothing measured', () => {
    const text = summary([
      status('throttled', 'Throttled by registry.npmjs.org (3 requests)'),
      status('throttled'),
      status('throttled'),
    ])

    expect(text).toContain('## perf (npm): throttled, not a budget failure')
    expect(text).toContain('so nothing was measured')
    expect(text).toContain('Re-run failed jobs')
    expect(text).toContain('Throttled by registry.npmjs.org (3 requests)')
    expect(text).toMatch(/Attempt 1\s+\| Attempt 2\s+\| Attempt 3/)
  })

  it('marks an over reading throttling left unconfirmed, and never heads it over budget', () => {
    const text = summary([
      status('failed'),
      status('throttled'),
      row({ ...UNDER, cold: 1.42 }),
    ])

    expect(text).toContain('## perf (npm): throttled, not a budget failure')
    expect(text).not.toContain('over budget')
    expect(text).toContain('The registry throttled 1 of 3 attempts')
    expect(text).toContain('over by 0.42 s (42%), not confirmed')
  })

  it('keeps the one over reading when the later attempts were throttled, and does not claim nothing was measured', () => {
    const text = summary([
      row({ ...UNDER, cold: 1.42 }),
      status('throttled'),
      status('throttled'),
    ])

    expect(text).toContain('throttled, not a budget failure')
    expect(text).toContain('1 of 3 attempts measured')
    expect(text).not.toContain('nothing was measured')
    expect(text).toContain('1.42 s')
  })

  it('shows a failed leg with the error text', () => {
    const text = summary([
      status('failed', 'npm install failed'),
      status('failed', 'npm install failed again'),
    ])

    expect(text).toContain('## perf (npm): failed')
    expect(text).toContain('npm install failed again')
  })

  it('cuts a row error to 20 lines', () => {
    const error = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`).join(
      '\n',
    )
    const text = summary([status('failed', error), status('failed', error)])

    expect(text).toContain('line 20\n')
    expect(text).not.toContain('line 21\n')
    expect(text).toContain('… 30 more lines cut')
  })

  it('fences the error with more backticks than the text holds', () => {
    const text = summary([
      status('failed', 'before\n```` \n# heading\n```\nafter'),
      status('failed', 'x'),
    ])

    expect(text).toContain('`````\nbefore\n````')
    expect(text).toMatch(/after\n`````\n/)
  })

  it('keeps a line of the error from reading as a workflow command', () => {
    const text = summary([
      status('failed', '::error::planted\n  ##[error]planted too\nfine'),
      status('failed', 'x'),
    ])

    expect(text).not.toMatch(/^\s*::error::planted/m)
    expect(text).not.toMatch(/^\s*##\[error\]/m)
    expect(text).toContain('\\::error::planted')
  })
})

describe('annotationsOf', () => {
  const notes = (attempts: Attempt[], leg: Leg = 'npm') =>
    annotationsOf(leg, attempts, budgetsFor(leg))

  it('writes nothing for a pass', () => {
    expect(notes([row(UNDER)])).toEqual([])
  })

  it('writes one error per confirmed breach, with the limit and the excess', () => {
    const attempts = [
      row({ ...UNDER, cold: 1.42, warm: 0.4 }),
      row({ ...UNDER, cold: 1.38, warm: 0.36 }),
    ]

    expect(notes(attempts)).toEqual([
      // `%` is `%25` in a workflow command; GitHub shows it as `%`.
      '::error title=perf (npm)::check, cold: 1.38 s against a limit of 1 s, over by 0.38 s (38%25)',
      '::error title=perf (npm)::check, warm: 0.36 s against a limit of 0.3 s, over by 60.0 ms (20%25)',
    ])
  })

  it('writes a warning, not an error, for a throttled leg', () => {
    const [note, ...rest] = notes([
      status('throttled'),
      status('throttled'),
      status('throttled'),
    ])

    expect(note).toMatch(
      /^::warning title=perf \(npm\)::throttled after 3 attempts/,
    )
    expect(rest).toEqual([])
  })

  it('writes an error for a failed leg', () => {
    expect(notes([status('failed'), status('failed')])).toEqual([
      '::error title=perf (npm)::the measurement failed after 2 attempts; see the job summary',
    ])
  })

  it('carries none of a row error, however it reads', () => {
    const planted = '::error::planted\r\n%0A::warning::more'
    const all = [
      ...notes([status('failed', planted), status('failed', planted)]),
      ...notes([
        status('throttled', planted),
        status('throttled', planted),
        status('throttled', planted),
      ]),
    ].join('\n')

    expect(all).not.toContain('planted')
    expect(all).not.toContain('more')
  })
})
