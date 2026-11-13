import fs from 'fs'
import os from 'os'
import path from 'path'
import { stripVTControlCharacters } from 'util'
import {
  cleanup,
  copyProject,
  installAtMinimum,
  type Manager,
  managerEnv,
  YARN_VERSIONS,
} from '../__tests__/integration/harness'
import type { ConfigFile } from '../src/types'
import { runProcess } from '../src/utils/runProcess'
import {
  type BenchDocument,
  formatDifference,
  formatMemory,
  formatSeconds,
  formatTiming,
  fullPackumentReads,
  hyperfineMajor,
  type MeasuredRow,
  medianDifference,
  movingRows,
  parseHyperfine,
  renderTable,
  type StartupResult,
  type Timing,
  throttledLines,
  type UnmeasuredRow,
} from './report'
import {
  COOLDOWN_CONFIG,
  coldCaches,
  jsonPathFrom,
  MOVING_CONFIG,
  managerOf,
  runsFrom,
  selectedTargets,
  startupMode,
  type Target,
} from './targets'

const BENCH = __dirname
const REPO_ROOT = path.join(BENCH, '..')
const DIST_CLI = path.join(REPO_ROOT, 'dist', 'index.cjs')

// Timed runs per measurement. Berry's warm check takes seconds and bun's cold
// one over ten, so the counts stay small; AUTD_BENCH_RUNS replaces the check ones.
const CHECK_RUNS = { warm: 5, cold: 3 }
const STARTUP_RUNS = 80

const YARN_PACKAGE_MANAGER = {
  yarn: `yarn@${YARN_VERSIONS.yarn}`,
  berry: `yarn@${YARN_VERSIONS.berry}`,
} as const

type Runs = { warm: number; cold: number }

type Outcome = MeasuredRow | UnmeasuredRow

/** A timed run that a host throttled: its numbers are no measurement of the row (#174). */
class ThrottledRun extends Error {}

const KEEP = 'AUTD_BENCH_KEEP'

const log = (message: string): void => {
  process.stderr.write(`${message}\n`)
}

const quote = (value: string): string => `'${value.replaceAll("'", `'\\''`)}'`

const output = (error: unknown): string => {
  const failure = error as { stdout?: string; stderr?: string }
  return stripVTControlCharacters(
    `${failure.stdout ?? ''}${failure.stderr ?? ''}`,
  ).trim()
}

/** `AUTD_BENCH_CLI`: the autd build to time, the checkout's own `dist/index.cjs` unless set. */
const cliPath = (given: string | undefined): string => {
  const cli = given ? path.resolve(given) : DIST_CLI
  if (!fs.existsSync(cli)) {
    throw new Error(
      given
        ? `AUTD_BENCH_CLI: ${cli} does not exist`
        : `${cli} is missing: run pnpm run build`,
    )
  }
  return cli
}

/** `AUTD_BENCH_PROJECT`: `pinned` (the baseline: every dependency an exact old version) or `ranges`; unset or blank is `pinned`. */
const projectName = (value: string | undefined): 'pinned' | 'ranges' => {
  const name = value?.trim() || 'pinned'
  if (name !== 'pinned' && name !== 'ranges') {
    throw new Error(
      `AUTD_BENCH_PROJECT: unknown project ${name}; use pinned, ranges`,
    )
  }
  return name
}

const assertHyperfine = async (): Promise<void> => {
  let version: string
  try {
    version = (
      await runProcess('hyperfine', ['--version'], { cwd: os.tmpdir() })
    ).stdout
  } catch {
    throw new Error(
      'hyperfine is not installed or not on PATH: https://github.com/sharkdp/hyperfine (version 2 or later)',
    )
  }
  const major = hyperfineMajor(version)
  if (major === undefined || major < 2) {
    throw new Error(
      `hyperfine 2 or later is required, found ${version.trim()}: https://github.com/sharkdp/hyperfine`,
    )
  }
}

/**
 * Runs hyperfine in `cwd` and returns the timing of each command (argument
 * arrays), in order, with everything it printed. hyperfine discards what the
 * commands print unless `options` says otherwise, so on failure each one runs
 * once outside it and its output goes into the error.
 */
const hyperfine = async (
  cwd: string,
  options: string[],
  commands: string[][],
): Promise<{ timings: Timing[]; output: string }> => {
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'autd-bench-hf-')),
    'result.json',
  )
  try {
    // -N: no shell around the timed command. --prepare always runs in one.
    const { stdout, stderr } = await runProcess(
      'hyperfine',
      [
        '-N',
        ...options,
        '--export-json',
        out,
        ...commands.map((command) => command.map(quote).join(' ')),
      ],
      { cwd },
    )
    return {
      timings: parseHyperfine(fs.readFileSync(out, 'utf8')),
      output: `${stdout}${stderr}`,
    }
  } catch (error) {
    let detail = output(error) || String(error)
    for (const [file, ...args] of commands) {
      try {
        await runProcess(file, args, { cwd })
      } catch (failed) {
        detail += `\n${[file, ...args].join(' ')} on its own: ${output(failed) || String(failed)}`
      }
    }
    throw new Error(
      `hyperfine ${commands.map((command) => command.join(' ')).join(' ; ')} failed in ${cwd}\n${detail}`,
    )
  } finally {
    fs.rmSync(path.dirname(out), { recursive: true, force: true })
  }
}

/**
 * Times `check` in `cwd`. Throws `ThrottledRun` when autd says a host throttled
 * any run, warm-up included. `--show-output` is the one hyperfine mode that
 * keeps every run's output with no shell around the command: `--output=<file>`
 * keeps only the last run's.
 */
const timedCheck = async (
  cwd: string,
  measurement: string,
  options: string[],
  check: string[],
): Promise<Timing> => {
  const { timings, output: printed } = await hyperfine(
    cwd,
    ['--show-output', ...options],
    [check],
  )
  const throttled = throttledLines(printed)
  if (throttled.length > 0) {
    throw new ThrottledRun(
      `${measurement}: ${throttled.length} of its runs printed: ${throttled[0]}\nThe row's numbers are left out; run the bench again once the registry stops throttling.`,
    )
  }
  return timings[0]
}

/**
 * `autd update --dry-run --json`'s stdout in `cwd`. A failed run prints its
 * `{ error }` document there too, which `movingRows` words.
 */
const dryRunJson = async (cli: string, cwd: string): Promise<string> => {
  try {
    return (
      await runProcess(
        process.execPath,
        [cli, 'update', '--dry-run', '--json'],
        { cwd },
      )
    ).stdout
  } catch (error) {
    const { stdout } = error as { stdout?: string }
    if (stdout?.trim()) return stdout
    throw new Error(
      `autd update --dry-run --json failed in ${cwd}\n${output(error) || String(error)}`,
    )
  }
}

/** Corepack shims for yarn in `dir`, so the manifests' `packageManager` picks yarn 1 or berry. */
const enableYarn = async (dir: string): Promise<void> => {
  fs.mkdirSync(dir, { recursive: true })
  try {
    // From the repository, so asdf and mise resolve Node by its .tool-versions.
    await runProcess(
      'corepack',
      ['enable', '--install-directory', dir, 'yarn'],
      { cwd: REPO_ROOT },
    )
  } catch (error) {
    throw new Error(
      `corepack is not available: it ships with Node, run corepack enable\n${output(error) || String(error)}`,
    )
  }
  process.env.PATH = `${dir}${path.delimiter}${process.env.PATH ?? ''}`
}

/** The manager's version, as the label of its row. */
const labelOf = async (target: Target, cwd: string): Promise<string> => {
  const manager = managerOf(target)
  const name = manager === 'berry' ? 'yarn' : manager
  const version = (await runProcess(name, ['--version'], { cwd })).stdout.trim()
  switch (target) {
    case 'yarn':
      return `${name} ${version} (v1)`
    case 'berry':
      return `${name} ${version} (berry, PnP)`
    case 'berry-nm':
      return `${name} ${version} (berry, node-modules)`
    default:
      return `${name} ${version}`
  }
}

/** The copy of the benchmark project one target runs on, with the manifest and linker that target needs. */
const copyBenchProject = (target: Target, project: string): string => {
  const cwd = copyProject(path.join(BENCH, project), `bench-${target}`)
  const manager = managerOf(target)
  if (manager === 'yarn' || manager === 'berry') {
    const file = path.join(cwd, 'package.json')
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as object
    fs.writeFileSync(
      file,
      `${JSON.stringify({ ...manifest, packageManager: YARN_PACKAGE_MANAGER[manager] }, null, 2)}\n`,
    )
  }
  if (target === 'berry-nm') {
    fs.writeFileSync(
      path.join(cwd, '.yarnrc.yml'),
      'nodeLinker: node-modules\n',
    )
  }
  return cwd
}

/**
 * One untimed cold `check` with `debug: true` on the cooldown config, and the
 * packuments it read in full (#176). It runs outside every hyperfine
 * measurement. A failed run logs a line and returns nothing: the diagnostic
 * never fails the row.
 */
const readFullPackuments = async (
  cli: string,
  cwd: string,
  label: string,
  cacheDirs: string[],
  writeConfig: (value: ConfigFile) => void,
): Promise<string[] | undefined> => {
  try {
    log(`${label}: check, cold, cooldown 7, debug (untimed)`)
    for (const dir of cacheDirs) {
      fs.rmSync(dir, { recursive: true, force: true })
    }
    writeConfig({ ...COOLDOWN_CONFIG, debug: true })
    const { stdout, stderr } = await runProcess(
      process.execPath,
      [cli, 'check'],
      { cwd },
    )
    return fullPackumentReads(`${stdout}\n${stderr}`)
  } catch (error) {
    const detail = (output(error) || String(error)).split('\n')[0]
    log(`${label}: the debug run failed, no full packuments listed: ${detail}`)
    return undefined
  }
}

/** Installs the project for one target and times it; the temp copy is removed (or kept) before returning. */
const measure = async (
  target: Target,
  cli: string,
  project: string,
  cacheRoot: string,
  runs: Runs,
): Promise<MeasuredRow> => {
  const manager: Manager = managerOf(target)
  const restoreEnv = managerEnv(manager)
  let cwd: string | undefined
  let config: string | undefined
  try {
    const caches = coldCaches(target, cacheRoot)
    Object.assign(process.env, caches.env)
    if (manager === 'yarn' || manager === 'berry') {
      await enableYarn(path.join(cacheRoot, 'corepack-shims'))
    }

    cwd = copyBenchProject(target, project)
    log(`${target}: installing`)
    await installAtMinimum(manager, `bench-${target}`, cwd)
    const label = await labelOf(target, cwd)

    const check = [process.execPath, cli, 'check']

    const warmRuns = ['--warmup', '1', '--runs', String(runs.warm)]
    log(`${label}: check, warm`)
    const warm = await timedCheck(cwd, 'check, warm', warmRuns, check)

    log(`${label}: check, cold`)
    const coldRuns = [
      '--prepare',
      `rm -rf ${caches.dirs.map(quote).join(' ')}`,
      '--runs',
      String(runs.cold),
    ]
    const cold = await timedCheck(cwd, 'check, cold', coldRuns, check)

    // Cooldown only costs something on a row with a target, and the default
    // policy holds every exact pin: the moving config gives all of them one.
    const file = path.join(cwd, '.always-up-to-date.json')
    config = file
    const writeConfig = (value: ConfigFile): void => {
      fs.writeFileSync(file, `${JSON.stringify(value)}\n`)
    }
    writeConfig(MOVING_CONFIG)
    const targets = movingRows(await dryRunJson(cli, cwd))
    if (targets === 0) {
      throw new Error(
        `${label}: ${JSON.stringify(MOVING_CONFIG)} plans no update on ${project}: the cooldown rows would measure nothing`,
      )
    }

    log(`${label}: check, cold, ${targets} planned updates`)
    const moving = await timedCheck(cwd, 'moving, cold', coldRuns, check)

    log(`${label}: check, cold, cooldown 7`)
    writeConfig(COOLDOWN_CONFIG)
    const cooldownCold = await timedCheck(
      cwd,
      'cooldown 7, cold',
      coldRuns,
      check,
    )

    log(`${label}: check, warm, cooldown 7`)
    const cooldownWarm = await timedCheck(
      cwd,
      'cooldown 7, warm',
      warmRuns,
      check,
    )
    const fullPackuments = await readFullPackuments(
      cli,
      cwd,
      label,
      caches.dirs,
      writeConfig,
    )
    return {
      target,
      status: 'measured',
      label,
      warm,
      cold,
      targets,
      moving,
      cooldownCold,
      cooldownWarm,
      ...(fullPackuments === undefined ? {} : { fullPackuments }),
    }
  } finally {
    // A kept copy must not keep a bench config, failed run or not.
    if (config !== undefined) fs.rmSync(config, { force: true })
    restoreEnv()
    if (cwd !== undefined) cleanup(cwd, KEEP)
  }
}

/** The startup measurement: `--version` against bare node, output discarded since no registry is asked. */
const measureStartup = async (cli: string): Promise<StartupResult> => {
  log('startup: --version against bare node')
  try {
    const { timings } = await hyperfine(
      os.tmpdir(),
      ['--warmup', '3', '--runs', String(STARTUP_RUNS)],
      [
        [process.execPath, cli, '--version'],
        [process.execPath, '-e', '0'],
      ],
    )
    return { status: 'measured', version: timings[0], bare: timings[1] }
  } catch (error) {
    return {
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** `full packuments: <row>: none; <row>: next, …`, or nothing when no row ran the diagnostic. */
const fullPackumentsLine = (rows: MeasuredRow[]): string | undefined => {
  const read = rows.filter((row) => row.fullPackuments !== undefined)
  if (read.length === 0) return undefined
  return `full packuments: ${read
    .map((row) => `${row.label}: ${row.fullPackuments?.join(', ') || 'none'}`)
    .join('; ')}`
}

const main = async (): Promise<void> => {
  if (process.platform === 'win32') {
    throw new Error('pnpm run bench runs on macOS and Linux, not Windows')
  }
  const mode = startupMode(process.env.AUTD_BENCH_STARTUP)
  const selected = selectedTargets(process.env.AUTD_BENCH_PM)
  const targets = mode === 'only' ? [] : selected
  const project = projectName(process.env.AUTD_BENCH_PROJECT)
  const cli = cliPath(process.env.AUTD_BENCH_CLI)
  const jsonFile = jsonPathFrom(process.env.AUTD_BENCH_JSON, process.cwd())
  const runs: Runs = {
    warm: runsFrom(process.env.AUTD_BENCH_RUNS, CHECK_RUNS.warm),
    cold: runsFrom(process.env.AUTD_BENCH_RUNS, CHECK_RUNS.cold),
  }
  await assertHyperfine()

  const cacheRoot = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'autd-bench-cache-')),
  )
  try {
    const outcomes: Outcome[] = []
    for (const target of targets) {
      try {
        outcomes.push(await measure(target, cli, project, cacheRoot, runs))
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        const status = error instanceof ThrottledRun ? 'throttled' : 'failed'
        log(`${target}: ${status}`)
        outcomes.push({ target, status, error: message })
      }
    }

    const startup = mode === 'skip' ? undefined : await measureStartup(cli)

    const autd = (
      await runProcess(process.execPath, [cli, '--version'], {
        cwd: os.tmpdir(),
      }).catch(() => ({ stdout: 'unknown version' }))
    ).stdout.trim()

    if (jsonFile !== undefined) {
      const document: BenchDocument = {
        version: 1,
        autd,
        node: process.versions.node,
        platform: process.platform,
        arch: process.arch,
        project,
        rows: outcomes,
        ...(startup === undefined ? {} : { startup }),
      }
      fs.writeFileSync(jsonFile, `${JSON.stringify(document, null, 2)}\n`)
      log(`wrote ${jsonFile}`)
    }

    process.stdout.write(
      `\nautd ${autd} (${cli}), node ${process.versions.node}, ${process.platform} ${process.arch}, project ${project}\n\n`,
    )
    if (outcomes.length > 0) {
      process.stdout.write(
        `${renderTable(
          [
            'Manager',
            '`autd check`, warm',
            '`autd check`, cold',
            'peak memory, warm',
          ],
          outcomes.map((outcome) =>
            outcome.status === 'measured'
              ? [
                  outcome.label,
                  formatTiming(outcome.warm),
                  formatTiming(outcome.cold),
                  formatMemory(outcome.warm.peakMemory),
                ]
              : [outcome.target, outcome.status, outcome.status, 'n/a'],
          ),
        )}\n\n`,
      )
      process.stdout.write(
        `${renderTable(
          [
            'Manager',
            'targets',
            'moving, cold',
            'cooldown 7, cold',
            'cooldown overhead, cold',
            'cooldown 7, warm',
            'peak memory, moving cold',
            'peak memory, cooldown 7 cold',
          ],
          outcomes.map((outcome) =>
            outcome.status === 'measured'
              ? [
                  outcome.label,
                  String(outcome.targets),
                  formatTiming(outcome.moving),
                  formatTiming(outcome.cooldownCold),
                  formatDifference(
                    medianDifference(outcome.cooldownCold, outcome.moving),
                  ),
                  formatTiming(outcome.cooldownWarm),
                  formatMemory(outcome.moving.peakMemory),
                  formatMemory(outcome.cooldownCold.peakMemory),
                ]
              : [
                  outcome.target,
                  outcome.status,
                  outcome.status,
                  outcome.status,
                  outcome.status,
                  outcome.status,
                  'n/a',
                  'n/a',
                ],
          ),
        )}\n`,
      )
      const packuments = fullPackumentsLine(
        outcomes.filter((outcome) => outcome.status === 'measured'),
      )
      if (packuments) process.stdout.write(`\n${packuments}\n`)
      process.stdout.write('\n')
    }
    if (startup?.status === 'measured') {
      const { version, bare } = startup
      process.stdout.write(
        `${renderTable(
          ['Startup', 'mean', 'median'],
          [
            [
              '`autd --version`',
              formatTiming(version),
              formatSeconds(version.median),
            ],
            ['`node -e 0`', formatTiming(bare), formatSeconds(bare.median)],
            ['difference', '', formatSeconds(medianDifference(version, bare))],
          ],
        )}\n`,
      )
    }

    const failures = outcomes.filter((outcome) => outcome.status !== 'measured')
    for (const failure of failures) {
      process.stderr.write(
        `\n${failure.target} ${failure.status}:\n${failure.error}\n`,
      )
    }
    if (startup?.status === 'failed') {
      process.stderr.write(`\nstartup failed:\n${startup.error}\n`)
    }
    if (failures.length > 0 || startup?.status === 'failed') {
      process.exitCode = 1
    }
  } finally {
    cleanup(cacheRoot, KEEP)
  }
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  )
  process.exitCode = 1
})
