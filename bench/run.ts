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
import { runProcess } from '../src/utils/runProcess'
import {
  formatMemory,
  formatSeconds,
  formatTiming,
  hyperfineMajor,
  parseHyperfine,
  renderTable,
  type Timing,
} from './report'
import {
  coldCaches,
  managerOf,
  runsFrom,
  selectedTargets,
  type Target,
} from './targets'

const BENCH = __dirname
const REPO_ROOT = path.join(BENCH, '..')
const DIST_CLI = path.join(REPO_ROOT, 'dist', 'index.js')

// Timed runs per measurement. Berry's warm check takes seconds and bun's cold
// one over ten, so the counts stay small; AUTD_BENCH_RUNS replaces the check ones.
const CHECK_RUNS = { warm: 5, cold: 3 }
const STARTUP_RUNS = 30

const YARN_PACKAGE_MANAGER = {
  yarn: `yarn@${YARN_VERSIONS.yarn}`,
  berry: `yarn@${YARN_VERSIONS.berry}`,
} as const

type Runs = { warm: number; cold: number }

type Row = {
  label: string
  warm: Timing
  cold: Timing
  cooldown: Timing
}

type Outcome = { target: Target; row: Row } | { target: Target; error: string }

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

/** `AUTD_BENCH_CLI`: the autd build to time, the checkout's own `dist/index.js` unless set. */
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
 * arrays), in order. hyperfine discards what the commands print, so on failure
 * each one runs once outside it and its output goes into the error.
 */
const hyperfine = async (
  cwd: string,
  options: string[],
  commands: string[][],
): Promise<Timing[]> => {
  const out = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'autd-bench-hf-')),
    'result.json',
  )
  try {
    // -N: no shell around the timed command. --prepare always runs in one.
    await runProcess(
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
    return parseHyperfine(fs.readFileSync(out, 'utf8'))
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

/** Installs the project for one target and times it; the temp copy is removed (or kept) before returning. */
const measure = async (
  target: Target,
  cli: string,
  project: string,
  cacheRoot: string,
  runs: Runs,
): Promise<Row> => {
  const manager: Manager = managerOf(target)
  const restoreEnv = managerEnv(manager)
  let cwd: string | undefined
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

    log(`${label}: check, warm`)
    const [warm] = await hyperfine(
      cwd,
      ['--warmup', '1', '--runs', String(runs.warm)],
      [check],
    )

    log(`${label}: check, cold`)
    const [cold] = await hyperfine(
      cwd,
      [
        '--prepare',
        `rm -rf ${caches.dirs.map(quote).join(' ')}`,
        '--runs',
        String(runs.cold),
      ],
      [check],
    )

    log(`${label}: check, warm, cooldown 7`)
    const config = path.join(cwd, '.always-up-to-date.json')
    fs.writeFileSync(config, `${JSON.stringify({ cooldown: 7 })}\n`)
    const [cooldown] = await hyperfine(
      cwd,
      ['--warmup', '1', '--runs', String(runs.warm)],
      [check],
    )
    fs.rmSync(config)

    return { label, warm, cold, cooldown }
  } finally {
    restoreEnv()
    if (cwd !== undefined) cleanup(cwd, KEEP)
  }
}

const main = async (): Promise<void> => {
  if (process.platform === 'win32') {
    throw new Error('pnpm run bench runs on macOS and Linux, not Windows')
  }
  const targets = selectedTargets(process.env.AUTD_BENCH_PM)
  const project = projectName(process.env.AUTD_BENCH_PROJECT)
  const cli = cliPath(process.env.AUTD_BENCH_CLI)
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
        outcomes.push({
          target,
          row: await measure(target, cli, project, cacheRoot, runs),
        })
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log(`${target}: failed`)
        outcomes.push({ target, error: message })
      }
    }

    log('startup: --version against bare node')
    let startup: Timing[] | undefined
    let startupError: string | undefined
    try {
      startup = await hyperfine(
        os.tmpdir(),
        ['--warmup', '3', '--runs', String(STARTUP_RUNS)],
        [
          [process.execPath, cli, '--version'],
          [process.execPath, '-e', '0'],
        ],
      )
    } catch (error) {
      startupError = error instanceof Error ? error.message : String(error)
    }

    const autd = (
      await runProcess(process.execPath, [cli, '--version'], {
        cwd: os.tmpdir(),
      }).catch(() => ({ stdout: 'unknown version' }))
    ).stdout.trim()
    process.stdout.write(
      `\nautd ${autd} (${cli}), node ${process.versions.node}, ${process.platform} ${process.arch}, project ${project}\n\n`,
    )
    process.stdout.write(
      `${renderTable(
        [
          'Manager',
          '`autd check`, warm',
          '`autd check`, cold',
          'cooldown 7, warm',
          'peak memory',
          'peak memory, cooldown 7',
        ],
        outcomes.map((outcome) =>
          'row' in outcome
            ? [
                outcome.row.label,
                formatTiming(outcome.row.warm),
                formatTiming(outcome.row.cold),
                formatTiming(outcome.row.cooldown),
                formatMemory(outcome.row.warm.peakMemory),
                formatMemory(outcome.row.cooldown.peakMemory),
              ]
            : [outcome.target, 'failed', 'failed', 'failed', 'n/a', 'n/a'],
        ),
      )}\n\n`,
    )
    if (startup) {
      const [version, bare] = startup
      process.stdout.write(
        `${renderTable(
          ['Startup', 'mean'],
          [
            ['`autd --version`', formatTiming(version)],
            ['`node -e 0`', formatTiming(bare)],
            ['difference', formatSeconds(version.mean - bare.mean)],
          ],
        )}\n`,
      )
    }

    const failures = outcomes.filter((outcome) => 'error' in outcome)
    for (const failure of failures) {
      process.stderr.write(`\n${failure.target} failed:\n${failure.error}\n`)
    }
    if (startupError)
      process.stderr.write(`\nstartup failed:\n${startupError}\n`)
    if (failures.length > 0 || startupError) process.exitCode = 1
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
