import fs from 'fs'
import os from 'os'
import path from 'path'
import semver from 'semver'
import { stripVTControlCharacters } from 'util'
import { toPosix } from '@/managers/workspaces'
import { runProcess } from '@/utils/runProcess'
import { type ProxyRecord, startProxy } from '../fixtures/registry'
import {
  type RangedDependency,
  rewriteBerryLock,
  rewriteBunLock,
  rewriteNpmLock,
  rewritePnpmLock,
  rewriteYarnV1Lock,
} from './lockfiles'

export type { RangedDependency } from './lockfiles'

export const MANAGERS = ['npm', 'pnpm', 'yarn', 'berry', 'bun'] as const
export type Manager = (typeof MANAGERS)[number]

/** testRepos/<manager>-<layout>, the layouts each manager has. */
export const LAYOUTS: Record<Manager, readonly string[]> = {
  npm: ['single', 'workspace'],
  pnpm: ['single', 'workspace', 'catalogs'],
  yarn: ['single', 'workspace'],
  berry: ['single', 'workspace'],
  bun: ['single', 'workspace', 'catalogs'],
}

const REPO_ROOT = path.resolve(__dirname, '..', '..')
const TEST_REPOS = path.join(REPO_ROOT, 'testRepos')
export const CLI = path.join(REPO_ROOT, 'dist', 'index.js')

export const YARN_VERSIONS = { yarn: '1.22.22', berry: '4.12.0' } as const

/**
 * A comma-separated selection of `allowed` names; unset or blank selects them
 * all. An unknown or empty name (`npm,`) fails fast, naming `variable`.
 */
export const parseSelection = <T extends string>(
  value: string | undefined,
  allowed: readonly T[],
  variable: string,
): T[] => {
  if (value === undefined || value.trim() === '') return [...allowed]

  const names = value.split(',').map((name) => name.trim())
  const unknown = names.filter(
    (name) => !(allowed as readonly string[]).includes(name),
  )
  if (unknown.length > 0) {
    throw new Error(
      `${variable}: unknown manager ${unknown.map((name) => name || '(empty)').join(', ')}; use ${allowed.join(', ')}`,
    )
  }
  return names as T[]
}

/** `AUTD_INTEGRATION_PM`: a comma-separated selection; unset runs every manager. */
export const selectedManagers = (
  value: string | undefined = process.env.AUTD_INTEGRATION_PM,
): Manager[] => parseSelection(value, MANAGERS, 'AUTD_INTEGRATION_PM')

/**
 * Makes the process environment the same wherever the suite starts: `pnpm run`
 * exports `npm_config_*` variables that npm and yarn read, so they go, and
 * Corepack, yarn and telemetry never prompt or run scripts. runProcess hands
 * `process.env` to every child. Returns the restore.
 *
 * npm's user config points at an empty file, so a developer's `~/.npmrc`
 * (save-exact, save-prefix, a registry mirror) can't change the results; pnpm
 * reads it too. yarn's and bun's own home config (`~/.yarnrc.yml`,
 * `~/.bunfig.toml`) is not isolated. pnpm gets a store of its own in the temp
 * directory (pnpm 12 reads `pnpm_config_store_dir`, not `npm_config_store_dir`):
 * its installs would otherwise fill the global store, which CI may save in its
 * cache. autd gets a cache folder of its own in it too (`AUTD_CACHE_DIR`), and
 * the test setup's `AUTD_NO_CACHE` is dropped so the matrix runs with the cache on.
 */
export const managerEnv = (manager: Manager): (() => void) => {
  const saved = { ...process.env }
  const scratch = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), 'autd-it-env-')),
  )
  const userConfig = path.join(scratch, 'npmrc')
  fs.writeFileSync(userConfig, '')
  for (const key of Object.keys(process.env)) {
    if (/^npm_/i.test(key)) delete process.env[key]
  }
  delete process.env.PNPM_SCRIPT_SRC_DIR
  delete process.env.INIT_CWD
  delete process.env.AUTD_NO_CACHE
  Object.assign(process.env, {
    AUTD_CACHE_DIR: path.join(scratch, 'autd-cache'),
    COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
    COREPACK_ENABLE_AUTO_PIN: '0',
    YARN_ENABLE_TELEMETRY: '0',
    YARN_ENABLE_SCRIPTS: 'false',
    npm_config_userconfig: userConfig,
    ...(manager === 'pnpm'
      ? { pnpm_config_store_dir: path.join(scratch, 'pnpm-store') }
      : {}),
  })

  return () => {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
    fs.rmSync(scratch, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 200,
    })
  }
}

const SKIPPED_BY_COPY = new Set([
  'node_modules',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  '.yarn',
])

/**
 * A copy of testRepos/<repo> in the temp directory, outside this repository:
 * the root pnpm-workspace.yaml, Biome and git never see it, and no manager
 * finds a parent project. The path is resolved to its long form (Windows
 * runners hand out 8.3 `RUNNER~1` names while pnpm reports long ones; macOS
 * `/var` is `/private/var`).
 */
export const copyRepo = (repo: string): string =>
  copyProject(path.join(TEST_REPOS, repo), repo)

/**
 * The name the fixtures' manifests are committed under. GitHub's dependency
 * graph reads every package.json in the repository, so fixtures pinned to old
 * versions on purpose raised Dependabot alerts; a copy renames them back.
 */
export const FIXTURE_MANIFEST = 'package.fixture.json'

const restoreManifests = (dir: string): void => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) restoreManifests(full)
    else if (entry.name === FIXTURE_MANIFEST) {
      fs.renameSync(full, path.join(dir, 'package.json'))
    }
  }
}

/** A copy of any project directory in the temp directory, as copyRepo makes one. */
export const copyProject = (source: string, label: string): string => {
  const dir = fs.realpathSync.native(
    fs.mkdtempSync(path.join(os.tmpdir(), `autd-it-${label}-`)),
  )
  fs.cpSync(source, dir, {
    recursive: true,
    filter: (entry) => {
      const name = path.basename(entry)
      return !SKIPPED_BY_COPY.has(name) && !name.startsWith('.pnp.')
    },
  })
  restoreManifests(dir)
  // asdf and mise pick a tool's version by directory: outside this repository
  // the copy would run the user's global bun or pnpm, not .tool-versions'.
  const toolVersions = path.join(REPO_ROOT, '.tool-versions')
  if (
    !fs.existsSync(path.join(source, '.tool-versions')) &&
    fs.existsSync(toolVersions)
  ) {
    fs.copyFileSync(toolVersions, path.join(dir, '.tool-versions'))
  }
  return dir
}

const DEPENDENCY_FIELDS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
] as const

const RANGE = /^[~^]\d+\.\d+\.\d+$/
const EXACT = /^\d+\.\d+\.\d+$/

/** The version to install for a spec, or undefined when the spec stays as it is. */
const minimumOf = (spec: string, where: string): string | undefined => {
  if (RANGE.test(spec)) {
    const minimum = semver.minVersion(spec)
    if (!minimum) throw new Error(`${where}: ${spec} has no minimum version`)
    return minimum.version
  }
  if (EXACT.test(spec) || /^(catalog|workspace):/.test(spec)) return undefined
  throw new Error(
    `${where}: ${spec} is not allowed; testRepos use only exact, ^ and ~ specs`,
  )
}

const manifestsUnder = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      return entry.name === 'node_modules' || entry.name === '.yarn'
        ? []
        : manifestsUnder(full)
    }
    return entry.name === 'package.json' ? [full] : []
  })

/** The catalog entries of a pnpm-workspace.yaml, rewritten in place line by line. */
export const pinWorkspaceYaml = (
  text: string,
  onEntry: (catalog: string, name: string, spec: string) => string | undefined,
): string => {
  const eol = text.includes('\r\n') ? '\r\n' : '\n'
  let section: 'catalog' | 'catalogs' | undefined
  let group: string | undefined

  return text
    .split(/\r?\n/)
    .map((line) => {
      if (/^catalogs:\s*$/.test(line)) {
        section = 'catalogs'
        group = undefined
        return line
      }
      if (/^catalog:\s*$/.test(line)) {
        section = 'catalog'
        return line
      }
      if (/^\S/.test(line) && !line.startsWith('#')) {
        section = undefined
        group = undefined
        return line
      }
      if (section === 'catalogs') {
        const named = /^ {2}([^\s:]+):\s*$/.exec(line)
        if (named) {
          group = named[1]
          return line
        }
      }
      const catalog = section === 'catalog' ? 'default' : group
      const entry = /^(\s+)([^\s:#]+):\s+(\S.*?)\s*$/.exec(line)
      if (catalog === undefined || !entry) return line
      const replaced = onEntry(catalog, entry[2], entry[3])
      return replaced === undefined
        ? line
        : `${entry[1]}${entry[2]}: ${replaced}`
    })
    .join(eol)
}

/**
 * Replaces every `^x.y.z` and `~x.y.z` spec under `cwd` (manifests, bun's
 * `catalog`/`catalogs`, pnpm-workspace.yaml catalogs) by the exact minimum the
 * range allows, so the next install resolves old versions. `restore()` writes
 * back the original bytes of every file touched.
 */
export const pinToMinimum = (
  cwd: string,
): { restore: () => void; ranged: RangedDependency[] } => {
  const originals = new Map<string, Buffer>()
  const ranged: RangedDependency[] = []

  const touch = (file: string): void => {
    if (!originals.has(file)) originals.set(file, fs.readFileSync(file))
  }

  for (const file of manifestsUnder(cwd)) {
    const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
      string,
      unknown
    >
    const workspace = toPosix(path.relative(cwd, path.dirname(file))) || '.'
    let changed = false

    const pin = (
      map: Record<string, string>,
      origin: Pick<RangedDependency, 'workspace' | 'catalog'>,
    ): void => {
      for (const [name, spec] of Object.entries(map)) {
        const installed = minimumOf(spec, `${file} ${name}`)
        if (installed === undefined) continue
        ranged.push({ ...origin, name, range: spec, installed })
        map[name] = installed
        changed = true
      }
    }

    for (const field of DEPENDENCY_FIELDS) {
      const map = manifest[field]
      if (map) pin(map as Record<string, string>, { workspace })
    }
    if (manifest.catalog) {
      pin(manifest.catalog as Record<string, string>, { catalog: 'default' })
    }
    for (const [name, map] of Object.entries(
      (manifest.catalogs ?? {}) as Record<string, Record<string, string>>,
    )) {
      pin(map, { catalog: name })
    }

    if (changed) {
      touch(file)
      fs.writeFileSync(file, `${JSON.stringify(manifest, null, 2)}\n`)
    }
  }

  const yamlFile = path.join(cwd, 'pnpm-workspace.yaml')
  if (fs.existsSync(yamlFile)) {
    const text = fs.readFileSync(yamlFile, 'utf8')
    let changed = false
    const pinned = pinWorkspaceYaml(text, (catalog, name, spec) => {
      const installed = minimumOf(spec, `${yamlFile} ${name}`)
      if (installed === undefined) return undefined
      ranged.push({ catalog, name, range: spec, installed })
      changed = true
      return installed
    })
    if (changed) {
      touch(yamlFile)
      fs.writeFileSync(yamlFile, pinned)
    }
  }

  return {
    ranged,
    restore: () => {
      for (const [file, bytes] of originals) fs.writeFileSync(file, bytes)
    },
  }
}

const run = async (
  cwd: string,
  file: string,
  args: string[],
): Promise<string> => {
  try {
    return (await runProcess(file, args, { cwd })).stdout
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    throw new Error(
      `${[file, ...args].join(' ')} failed in ${cwd}\n${stripVTControlCharacters(`${failure.stdout ?? ''}${failure.stderr ?? ''}`)}`,
    )
  }
}

const rewriteLock = (
  cwd: string,
  file: string,
  rewrite: (lock: string, ranged: RangedDependency[]) => string,
  ranged: RangedDependency[],
): void => {
  const lockFile = path.join(cwd, file)
  fs.writeFileSync(lockFile, rewrite(fs.readFileSync(lockFile, 'utf8'), ranged))
}

/**
 * A ready-to-check copy of testRepos/<repo>: installed at the minimum of every
 * range, ranges restored, and the lockfile made to agree. Returns the copy's
 * directory and the ranges that were simulated.
 *
 * The install flags that follow are needed under `CI=true`: pnpm freezes its
 * lockfile and berry turns on immutable installs there, and a first install has
 * no lockfile to freeze to.
 */
export const prepareRepo = async (
  repo: string,
): Promise<{ cwd: string; ranged: RangedDependency[] }> => {
  const manager = repo.slice(0, repo.indexOf('-')) as Manager
  const cwd = copyRepo(repo)
  try {
    return { cwd, ranged: await installAtMinimum(manager, repo, cwd) }
  } catch (error) {
    // Nobody else knows this copy: remove it (or keep it, if asked) and rethrow.
    cleanup(cwd)
    throw error
  }
}

/**
 * Installs the copy in `cwd` at the minimum of every range, restores the ranges
 * and makes the lockfile agree, as prepareRepo does. `repo` only names the
 * copy in error messages.
 */
export const installAtMinimum = async (
  manager: Manager,
  repo: string,
  cwd: string,
): Promise<RangedDependency[]> => {
  if (manager === 'yarn' || manager === 'berry') {
    const version = (await run(cwd, 'yarn', ['--version'])).trim()
    if (version !== YARN_VERSIONS[manager]) {
      throw new Error(
        `${repo}: yarn ${version} ran, expected ${YARN_VERSIONS[manager]}: put the Corepack shims first on PATH (corepack enable yarn)`,
      )
    }
  }

  const { restore, ranged } = pinToMinimum(cwd)
  switch (manager) {
    case 'npm':
      await run(cwd, 'npm', [
        'install',
        '--no-audit',
        '--no-fund',
        '--ignore-scripts',
      ])
      restore()
      rewriteLock(cwd, 'package-lock.json', rewriteNpmLock, ranged)
      break
    case 'pnpm':
      await run(cwd, 'pnpm', [
        'install',
        '--no-frozen-lockfile',
        '--ignore-scripts',
      ])
      restore()
      rewriteLock(cwd, 'pnpm-lock.yaml', rewritePnpmLock, ranged)
      // The check that the rewritten lockfile agrees with the manifests: a
      // frozen install fails when it doesn't. (npm has no such command that
      // wouldn't re-resolve; its `check` assertions catch a disagreement.)
      await run(cwd, 'pnpm', [
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
      ])
      break
    case 'yarn':
      await run(cwd, 'yarn', [
        'install',
        '--non-interactive',
        '--ignore-scripts',
      ])
      restore()
      rewriteLock(cwd, 'yarn.lock', rewriteYarnV1Lock, ranged)
      break
    case 'berry':
      // An empty yarn.lock marks the copy as a project root.
      fs.writeFileSync(path.join(cwd, 'yarn.lock'), '')
      await run(cwd, 'yarn', ['install', '--no-immutable'])
      restore()
      rewriteLock(cwd, 'yarn.lock', rewriteBerryLock, ranged)
      // Keeps the resolved versions and prunes the keys the ranges don't use.
      await run(cwd, 'yarn', ['install', '--no-immutable'])
      break
    case 'bun':
      await run(cwd, 'bun', ['install', '--ignore-scripts'])
      restore()
      rewriteLock(cwd, 'bun.lock', rewriteBunLock, ranged)
      break
  }
  return ranged
}

/**
 * What a manager's frozen install runs to prove the lockfile agrees with the
 * manifests: it fails when it doesn't. npm's `ci` is the frozen install.
 */
const FROZEN_INSTALL: Record<Manager, [string, string[]]> = {
  npm: ['npm', ['ci', '--no-audit', '--no-fund', '--ignore-scripts']],
  pnpm: ['pnpm', ['install', '--frozen-lockfile', '--ignore-scripts']],
  yarn: [
    'yarn',
    ['install', '--frozen-lockfile', '--non-interactive', '--ignore-scripts'],
  ],
  berry: ['yarn', ['install', '--immutable']],
  bun: ['bun', ['install', '--frozen-lockfile', '--ignore-scripts']],
}

/** Runs the manager's frozen install in `cwd`; it rejects when the lockfile disagrees with the manifests. */
export const frozenInstall = async (
  manager: Manager,
  cwd: string,
): Promise<void> => {
  const [file, args] = FROZEN_INSTALL[manager]
  await run(cwd, file, args)
}

const SNAPSHOT_FILES = new Set([
  'package.json',
  'package-lock.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lock',
  'pnpm-workspace.yaml',
  '.always-up-to-date.json',
])

/** The bytes of every manifest, lockfile, workspace yaml and config under `cwd`, by relative path. */
export const snapshotFiles = (cwd: string): Record<string, string> => {
  const files: Record<string, string> = {}
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name !== 'node_modules' && entry.name !== '.yarn') walk(full)
      } else if (SNAPSHOT_FILES.has(entry.name)) {
        files[toPosix(path.relative(cwd, full))] = fs.readFileSync(
          full,
          'latin1',
        )
      }
    }
  }
  walk(cwd)
  return files
}

/** Removes a prepared copy, unless `keepVariable` (`AUTD_INTEGRATION_KEEP` by default) is `1`, which prints its path instead. */
export const cleanup = (
  cwd: string,
  keepVariable = 'AUTD_INTEGRATION_KEEP',
): void => {
  if (process.env[keepVariable] === '1') {
    process.stderr.write(`kept ${cwd}\n`)
    return
  }
  fs.rmSync(cwd, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 200,
  })
}

/** `beforeAll`: the CLI is built. */
export const assertBuilt = (): void => {
  if (!fs.existsSync(CLI)) {
    throw new Error(`${CLI} is missing: run pnpm run build`)
  }
}

/** Runs the built CLI in `cwd` and parses what it prints on stdout. */
export const runCli = async (cwd: string, args: string[]): Promise<unknown> => {
  const command = `autd ${args.join(' ')} in ${cwd}`
  let result: { stdout: string; stderr: string }
  try {
    result = await runProcess(process.execPath, [CLI, ...args], { cwd })
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string }
    throw new Error(
      `${command} failed\nstdout: ${failure.stdout ?? ''}\nstderr: ${stripVTControlCharacters(failure.stderr ?? '')}`,
    )
  }
  try {
    return JSON.parse(result.stdout)
  } catch {
    throw new Error(
      `${command} printed no JSON\nstdout: ${result.stdout}\nstderr: ${stripVTControlCharacters(result.stderr)}`,
    )
  }
}

/** Runs `fn` with the PATH key (found case-insensitively, as `prependPath` does) pointing at an empty directory. */
const withoutManagers = async <T>(fn: () => Promise<T>): Promise<T> => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-empty-path-'))
  const key =
    Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const original = process.env[key]
  process.env[key] = empty
  try {
    return await fn()
  } finally {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
    fs.rmSync(empty, { recursive: true, force: true })
  }
}

/**
 * `runCli` with no package manager on PATH: the key points at an empty
 * directory for the call. The CLI starts from `process.execPath`, so only a
 * manager subprocess would fail.
 */
export const runCliWithoutManagers = (
  cwd: string,
  args: string[],
): Promise<unknown> => withoutManagers(() => runCli(cwd, args))

/**
 * Runs the built CLI in `cwd` with no package manager on PATH and expects exit
 * code 1: returns the JSON document it printed on stdout. A refusal that ran a
 * manager would fail differently.
 */
export const runCliExpectingFailure = (
  cwd: string,
  args: string[],
): Promise<unknown> =>
  withoutManagers(async () => {
    const command = `autd ${args.join(' ')} in ${cwd}`
    try {
      await runProcess(process.execPath, [CLI, ...args], { cwd })
    } catch (error) {
      const failure = error as { code?: unknown; stdout?: string }
      if (failure.code !== 1) {
        throw new Error(`${command} exited with ${String(failure.code)}`)
      }
      return JSON.parse(failure.stdout ?? '')
    }
    throw new Error(`${command} exited 0, expected 1`)
  })

/**
 * `runCliWithoutManagers` with every registry request sent through a proxy
 * that records it, for the call: `seen` empty proves the run asked nobody. A
 * `NO_PROXY` (found case-insensitively) would let requests bypass it.
 */
export const runCliThroughTripwire = async (
  cwd: string,
  args: string[],
): Promise<{ output: unknown; seen: ProxyRecord[] }> => {
  const proxy = await startProxy()
  const saved = { ...process.env }
  for (const key of Object.keys(process.env)) {
    if (/^(https?|no)_proxy$/i.test(key)) delete process.env[key]
  }
  Object.assign(process.env, {
    HTTPS_PROXY: proxy.url,
    HTTP_PROXY: proxy.url,
    https_proxy: proxy.url,
    http_proxy: proxy.url,
  })
  try {
    return { output: await runCliWithoutManagers(cwd, args), seen: proxy.seen }
  } finally {
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
    await proxy.close()
  }
}

/** The dependency maps of every manifest under `cwd`, keyed by directory ('.' = root). */
export const readDependencies = (
  cwd: string,
): Record<string, Record<string, Record<string, string>>> =>
  Object.fromEntries(
    manifestsUnder(cwd)
      .map((file): [string, Record<string, Record<string, string>>] => {
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<
          string,
          Record<string, string> | undefined
        >
        const maps = Object.fromEntries(
          DEPENDENCY_FIELDS.flatMap((field) =>
            manifest[field] ? [[field, manifest[field]]] : [],
          ),
        )
        return [toPosix(path.relative(cwd, path.dirname(file))) || '.', maps]
      })
      .sort((a, b) => a[0].localeCompare(b[0])),
  )

/** The catalogs of the root: bun's in package.json, pnpm's in pnpm-workspace.yaml. */
export const readCatalogs = (
  cwd: string,
): Record<string, Record<string, string>> => {
  const catalogs: Record<string, Record<string, string>> = {}
  const add = (catalog: string, name: string, spec: string): void => {
    catalogs[catalog] = { ...catalogs[catalog], [name]: spec }
  }

  const manifest = JSON.parse(
    fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'),
  ) as {
    catalog?: Record<string, string>
    catalogs?: Record<string, Record<string, string>>
  }
  for (const [name, spec] of Object.entries(manifest.catalog ?? {})) {
    add('default', name, spec)
  }
  for (const [catalog, map] of Object.entries(manifest.catalogs ?? {})) {
    for (const [name, spec] of Object.entries(map)) add(catalog, name, spec)
  }

  const yamlFile = path.join(cwd, 'pnpm-workspace.yaml')
  if (fs.existsSync(yamlFile)) {
    pinWorkspaceYaml(
      fs.readFileSync(yamlFile, 'utf8'),
      (catalog, name, spec) => {
        add(catalog, name, spec)
        return undefined
      },
    )
  }
  return catalogs
}
