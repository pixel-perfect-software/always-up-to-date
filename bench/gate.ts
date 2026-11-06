import { spawn } from 'child_process'
import { randomUUID } from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  type Attempt,
  annotationsOf,
  attemptOf,
  budgetsFor,
  exitCodeOf,
  type Leg,
  legFrom,
  nextStep,
  renderSummary,
  verdictOf,
} from './budgets'

export type GateDeps = {
  leg: Leg
  /** Runs the bench once and returns the text of its document, `undefined` when it wrote none. */
  runBench: (attempt: number) => Promise<string | undefined>
  sleep: (seconds: number) => Promise<void>
  /** Appends the leg's summary. */
  writeSummary: (markdown: string) => void
  log: (line: string) => void
}

/**
 * Measures the leg until `nextStep` says stop, writes the summary and the
 * annotations, and returns the exit code: 0 passed, 1 over budget, 2 failed,
 * 3 throttled and inconclusive. A bench run's own exit code never reaches it:
 * only the document does.
 */
export const runGate = async ({
  leg,
  runBench,
  sleep,
  writeSummary,
  log,
}: GateDeps): Promise<number> => {
  const budgets = budgetsFor(leg)
  const attempts: Attempt[] = []
  for (;;) {
    log(`perf (${leg}): attempt ${attempts.length + 1}`)
    attempts.push(attemptOf(await runBench(attempts.length + 1), leg))
    const step = nextStep(attempts, budgets)
    if (step.done) break
    log(
      `perf (${leg}): attempt ${attempts.length} was ${attempts.at(-1)?.status}; measuring again in ${step.waitSeconds} s`,
    )
    await sleep(step.waitSeconds)
  }

  writeSummary(renderSummary(leg, attempts, budgets))
  for (const annotation of annotationsOf(leg, attempts, budgets)) {
    log(annotation)
  }
  const verdict = verdictOf(attempts, budgets)
  log(`perf (${leg}): ${verdict}`)
  return exitCodeOf(verdict)
}

const BENCH = __dirname
const REPO_ROOT = path.join(BENCH, '..')

/**
 * One fresh `bench/run.ts` process with inherited stdio. `startup` runs it with
 * `AUTD_BENCH_STARTUP=only`; a target with `AUTD_BENCH_PM=<target>` and
 * `AUTD_BENCH_STARTUP=skip`. Its exit code is ignored.
 *
 * Under GitHub Actions the bench's output is wrapped in `::stop-commands::`:
 * what a row's error carries (a manager's own words) reaches the log, and a
 * line of it starting `::` would otherwise act as a workflow command.
 */
const spawnBench = (
  leg: Leg,
  jsonFile: string,
  env: NodeJS.ProcessEnv,
): Promise<void> =>
  new Promise((resolve) => {
    const guard = env.GITHUB_ACTIONS === 'true' ? randomUUID() : undefined
    if (guard) process.stdout.write(`::stop-commands::${guard}\n`)
    const resume = (): void => {
      if (guard) process.stdout.write(`::${guard}::\n`)
      resolve()
    }
    const child = spawn(
      process.execPath,
      ['-r', path.join(BENCH, 'register.cjs'), path.join(BENCH, 'run.ts')],
      {
        cwd: REPO_ROOT,
        stdio: 'inherit',
        env: {
          ...env,
          AUTD_BENCH_JSON: jsonFile,
          AUTD_BENCH_STARTUP: leg === 'startup' ? 'only' : 'skip',
          AUTD_BENCH_PM: leg === 'startup' ? '' : leg,
        },
      },
    )
    child.once('error', resume)
    child.once('close', resume)
  })

const main = async (): Promise<number> => {
  const leg = legFrom(process.env.AUTD_BENCH_GATE_TARGET)
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-bench-gate-'))
  try {
    return await runGate({
      leg,
      runBench: async (attempt) => {
        const file = path.join(folder, `attempt-${attempt}.json`)
        await spawnBench(leg, file, process.env)
        try {
          return fs.readFileSync(file, 'utf8')
        } catch {
          return undefined
        }
      },
      sleep: (seconds) =>
        new Promise((resolve) => setTimeout(resolve, seconds * 1000)),
      writeSummary: (markdown) => {
        const target = process.env.GITHUB_STEP_SUMMARY
        if (target) fs.appendFileSync(target, `${markdown}\n`)
        else process.stdout.write(`\n${markdown}`)
      },
      log: (line) => process.stdout.write(`${line}\n`),
    })
  } finally {
    fs.rmSync(folder, { recursive: true, force: true })
  }
}

if (require.main === module) {
  main().then(
    (code) => {
      process.exitCode = code
    },
    (error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      )
      process.exitCode = 2
    },
  )
}
