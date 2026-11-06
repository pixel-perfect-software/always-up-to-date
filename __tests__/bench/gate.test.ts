import { type GateDeps, runGate } from '../../bench/gate'
import { readFixture } from '../fixtures'

// biome-ignore lint/suspicious/noExplicitAny: the tests overwrite fields the real type requires
type Loose = Record<string, any>
const capture: Loose = JSON.parse(readFixture('bench/document.json'))

const documentWith = (edit: (document: Loose) => void): string => {
  const document = structuredClone(capture)
  edit(document)
  return JSON.stringify(document)
}

const passing = readFixture('bench/document.json')
const overCold = documentWith((document) => {
  document.rows[0].cold.median = 1.42
})
const throttled = documentWith((document) => {
  document.rows[0] = {
    target: 'npm',
    status: 'throttled',
    error: 'Throttled by registry.npmjs.org (3 requests)',
  }
})
const failedRow = documentWith((document) => {
  document.rows[0] = {
    target: 'npm',
    status: 'failed',
    error: 'install failed',
  }
})

/** Runs the gate over documents served in order; the waits it asks for are recorded, never slept. */
const gate = async (
  documents: (string | undefined)[],
  leg: GateDeps['leg'] = 'npm',
) => {
  const waits: number[] = []
  const summaries: string[] = []
  const lines: string[] = []
  const asked: number[] = []
  const code = await runGate({
    leg,
    runBench: async (attempt) => {
      asked.push(attempt)
      return documents[attempt - 1]
    },
    sleep: async (seconds) => {
      waits.push(seconds)
    },
    writeSummary: (markdown) => summaries.push(markdown),
    log: (line) => lines.push(line),
  })
  return { code, waits, summaries, lines, asked }
}

describe('runGate', () => {
  it('passes on the first attempt with no wait', async () => {
    const result = await gate([passing])

    expect(result.code).toBe(0)
    expect(result.waits).toEqual([])
    expect(result.asked).toEqual([1])
    expect(result.summaries).toHaveLength(1)
    expect(result.summaries[0]).toContain('## perf (npm): passed')
  })

  it('waits 30 s after a reading over a budget, and fails when the second is over too', async () => {
    const result = await gate([overCold, overCold])

    expect(result.code).toBe(1)
    expect(result.waits).toEqual([30])
    expect(result.summaries[0]).toContain('over by 0.42 s (42%)')
    expect(result.lines.filter((line) => line.startsWith('::error'))).toEqual([
      '::error title=perf (npm)::check, cold: 1.42 s against a limit of 1 s, over by 0.42 s (42%25)',
    ])
  })

  it('passes when the confirming attempt is under', async () => {
    const result = await gate([overCold, passing])

    expect(result.code).toBe(0)
    expect(result.waits).toEqual([30])
  })

  it('waits 60 s, then 120 s, when throttled, and is inconclusive after three attempts', async () => {
    const result = await gate([throttled, throttled, throttled])

    expect(result.code).toBe(3)
    expect(result.waits).toEqual([60, 120])
    expect(result.asked).toEqual([1, 2, 3])
    expect(result.summaries).toHaveLength(1)
    expect(result.summaries[0]).toContain(
      '## perf (npm): throttled, not a budget failure',
    )
    expect(
      result.lines.filter((line) => line.startsWith('::warning')),
    ).toHaveLength(1)
  })

  it('measures after a throttled attempt and judges that reading', async () => {
    const result = await gate([throttled, passing])

    expect(result.code).toBe(0)
    expect(result.waits).toEqual([60])
  })

  it('retries a failed attempt once after 30 s', async () => {
    const result = await gate([failedRow, failedRow])

    expect(result.code).toBe(2)
    expect(result.waits).toEqual([30])
    expect(result.asked).toEqual([1, 2])
  })

  it('treats a missing document as a failed attempt', async () => {
    const result = await gate([undefined, passing])

    expect(result.code).toBe(0)
    expect(result.waits).toEqual([30])
  })

  it('does not stop for a third attempt after over, throttled, throttled', async () => {
    const result = await gate([overCold, throttled, throttled])

    expect(result.code).toBe(3)
    expect(result.waits).toEqual([30, 60])
    expect(result.summaries[0]).toContain('1.42 s')
  })

  it('gates the startup leg on the startup measurement', async () => {
    const slow = documentWith((document) => {
      document.startup.version.median = 0.06
    })

    const result = await gate([slow, slow], 'startup')

    expect(result.code).toBe(1)
    expect(result.summaries[0]).toContain('## perf (startup): over budget')
  })
})

describe('importing bench/gate', () => {
  it('runs nothing: the gate starts only as the entry point', () => {
    expect(process.exitCode).toBeUndefined()
  })
})
