import fs from 'fs'
import os from 'os'
import path from 'path'
import semver from 'semver'
import type { ManagerAdapter } from '@/managers'
import type { WorkspaceManifest } from '@/managers/adapter'
import type { Project } from '@/project'
import type {
  AlwaysUpToDateConfig,
  OutdatedEntry,
  RegistryPackage,
} from '@/types'
import { DEFAULT_CONFIG } from '@/utils/config'
import type { RegistrySession } from '@/utils/registry'
import {
  parseDepsDevPackage,
  parseDistTags,
  parsePackument,
} from '@/utils/registryDocuments'
import { registryBody } from './registry'

export { derive, registryBody as readRegistryBody } from './registry'

/**
 * Real package-manager output captured on the 40-dependency benchmark
 * project (Node 24). Paths are relative to this directory.
 */
export const readFixture = (relativePath: string): string =>
  fs.readFileSync(path.join(__dirname, relativePath), 'utf8')

/**
 * Builds the error a child process rejects with when it exits non-zero,
 * carrying the exit code and both streams like Node's own error does.
 */
export const exitError = (
  code: number,
  stdout: string,
  stderr: string,
): Error & { code: number; stdout: string; stderr: string } =>
  Object.assign(new Error(`Command failed with exit code ${code}`), {
    code,
    stdout,
    stderr,
  })

/**
 * A registry session that fails loudly: a unit test that reaches the registry
 * without saying so is a bug. `close` does nothing.
 */
export const fakeRegistry = (
  overrides: Partial<RegistrySession> = {},
): RegistrySession => {
  const unexpected = (): never => {
    throw new Error('unexpected registry access in a unit test')
  }
  return {
    registryConfig: unexpected,
    unusableRoute: () => undefined,
    client: unexpected,
    releaseTimes: unexpected,
    lookup: unexpected,
    close: () => undefined,
    ...overrides,
  }
}

export interface CapturedPackageOptions {
  /** Which captured document to read; both are the reader's sources. Default deps.dev. */
  source?: RegistryPackage['source']
  /**
   * An ISO instant: versions published after it are dropped, so an
   * expectation written on that date still holds. deps.dev captures only (a
   * packument capture has no publish times).
   */
  asOf?: string
}

/** `@types/ms` is captured as `types-ms`. */
const captureName = (name: string): string =>
  name.replace(/^@/, '').replace('/', '-')

/**
 * A `RegistryPackage` built by the reader's own parsers from the captures in
 * `fixtures/registry/`: `<file>.dist-tags` plus `<file>.deps-dev`, or
 * `<file>.packument`. A test-only approximation of `lookup`: when `asOf`
 * drops the captured `latest`, `latest` becomes the highest surviving stable
 * version (the highest surviving one if none is stable), where the registry
 * would have said what `latest` was on that date.
 */
export const capturedPackage = (
  name: string,
  { source = 'deps.dev', asOf }: CapturedPackageOptions = {},
): RegistryPackage => {
  const file = captureName(name)
  let latest: string | undefined
  let versions: RegistryPackage['versions'] | undefined
  if (source === 'deps.dev') {
    latest = parseDistTags(JSON.parse(registryBody(`${file}.dist-tags`)))
    versions = parseDepsDevPackage(JSON.parse(registryBody(`${file}.deps-dev`)))
  } else {
    const parsed = parsePackument(JSON.parse(registryBody(`${file}.packument`)))
    latest = parsed?.latest
    versions = parsed?.versions
  }
  if (!versions)
    throw new Error(`the ${source} capture of ${name} is unreadable`)

  if (asOf !== undefined) {
    const cutoff = Date.parse(asOf)
    if (versions.some((entry) => entry.publishedAt === undefined)) {
      throw new Error(
        `the ${source} capture of ${name} has no publish times for asOf`,
      )
    }
    versions = versions.filter(
      (entry) => Date.parse(entry.publishedAt as string) <= cutoff,
    )
  }
  if (versions.length === 0)
    throw new Error(`${name} has no version as of ${asOf}`)

  if (
    latest === undefined ||
    !versions.some((entry) => entry.version === latest)
  ) {
    const stable = versions.filter((entry) => !semver.prerelease(entry.version))
    latest = (stable.length > 0 ? stable : versions).at(-1)?.version as string
  }
  return { name, latest, versions, source }
}

/**
 * A registry session whose `lookup` answers from the captures and rejects
 * for any other name, so a test that asks for a package it didn't plan for
 * fails loudly.
 */
export const capturedRegistry = (
  names: string[],
  options: CapturedPackageOptions = {},
  overrides: Partial<RegistrySession> = {},
): RegistrySession =>
  fakeRegistry({
    lookup: async (name) => {
      if (!names.includes(name)) {
        throw new Error(`no registry capture was planned for ${name}`)
      }
      return { ok: true, package: capturedPackage(name, options) }
    },
    ...overrides,
  })

/**
 * Writes `node_modules/<name>/package.json` under `cwd/dir` ('.' is the
 * root) for each name: what a manager leaves for discovery to read.
 */
export const installPackages = (
  cwd: string,
  dir: string,
  versions: Record<string, string>,
): void => {
  for (const [name, version] of Object.entries(versions)) {
    const entry = path.join(cwd, dir, 'node_modules', name)
    fs.mkdirSync(entry, { recursive: true })
    fs.writeFileSync(
      path.join(entry, 'package.json'),
      JSON.stringify({ name, version }),
    )
  }
}

/** A project for the pipeline: the default config with `config` laid over it. */
export const projectFor = (
  adapter: ManagerAdapter,
  root: string,
  config: Partial<AlwaysUpToDateConfig> = {},
  registry: RegistrySession = fakeRegistry(),
  member?: WorkspaceManifest,
): Project => ({
  adapter,
  root,
  member,
  config: { ...DEFAULT_CONFIG, ...config },
  registry,
})

/**
 * The evidence workspace the `*-workspace` fixtures were captured in: root
 * `ws-root` (dayjs 1.11.9, ms ~2.1.1), `packages/a` `@ws/a` (ms 2.1.2) and
 * `packages/b` `@ws/b` (debug ~4.3.1, dayjs ^1.11.9). The members are listed
 * by `workspaces: ['packages/*']`, or by pnpm-workspace.yaml with `pnpm`.
 * `rootName: null` leaves the root unnamed.
 */
export const writeWorkspaceProject = (
  cwd: string,
  { pnpm = false, rootName = 'ws-root' as string | null } = {},
): void => {
  const write = (file: string, content: string | object): void => {
    fs.mkdirSync(path.dirname(path.join(cwd, file)), { recursive: true })
    fs.writeFileSync(
      path.join(cwd, file),
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
    )
  }
  write('package.json', {
    ...(rootName === null ? {} : { name: rootName }),
    version: '1.0.0',
    private: true,
    ...(pnpm ? {} : { workspaces: ['packages/*'] }),
    dependencies: { dayjs: '1.11.9', ms: '~2.1.1' },
  })
  if (pnpm) write('pnpm-workspace.yaml', 'packages:\n  - packages/*\n')
  write('packages/a/package.json', {
    name: '@ws/a',
    version: '1.0.0',
    dependencies: { ms: '2.1.2' },
  })
  write('packages/b/package.json', {
    name: '@ws/b',
    version: '1.0.0',
    dependencies: { debug: '~4.3.1', dayjs: '^1.11.9' },
  })
}

/** What every manager's `*-workspace` fixture parses to, in no particular order. */
export const WORKSPACE_ENTRIES: OutdatedEntry[] = [
  {
    name: 'dayjs',
    workspace: '.',
    current: '1.11.9',
    wanted: '1.11.9',
    latest: '1.11.23',
  },
  {
    name: 'dayjs',
    workspace: 'packages/b',
    current: '1.11.9',
    wanted: '1.11.23',
    latest: '1.11.23',
  },
  {
    name: 'debug',
    workspace: 'packages/b',
    current: '4.3.1',
    wanted: '4.3.7',
    latest: '4.4.3',
  },
  {
    name: 'ms',
    workspace: '.',
    current: '2.1.1',
    wanted: '2.1.3',
    latest: '2.1.3',
  },
  {
    name: 'ms',
    workspace: 'packages/a',
    current: '2.1.2',
    wanted: '2.1.2',
    latest: '2.1.3',
  },
]

/**
 * Puts `dir` first on PATH and returns the function that restores it. Windows
 * spells the variable `Path`, so the existing key is found case-insensitively.
 */
export const prependPath = (dir: string): (() => void) => {
  const key =
    Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const original = process.env[key]
  process.env[key] = [dir, original].filter(Boolean).join(path.delimiter)
  return () => {
    if (original === undefined) delete process.env[key]
    else process.env[key] = original
  }
}

/**
 * Keeps the developer's npm configuration out of a test: drops every
 * `npm_config_*` variable (any case) and points `HOME` and `PREFIX` at `dir`,
 * so the user and global .npmrc files are `dir`'s own. Returns the restore.
 */
export const isolateNpmConfig = (dir: string): (() => void) => {
  const saved = new Map<string, string | undefined>()
  const remember = (key: string) => {
    if (!saved.has(key)) saved.set(key, process.env[key])
  }
  for (const key of Object.keys(process.env)) {
    if (!/^npm_config_/i.test(key)) continue
    remember(key)
    delete process.env[key]
  }
  remember('HOME')
  remember('PREFIX')
  process.env.HOME = dir
  process.env.PREFIX = dir
  const homedir = jest.spyOn(os, 'homedir').mockReturnValue(dir)
  return () => {
    homedir.mockRestore()
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
}

// npm/cmd-shim's template: what npm, pnpm and Corepack install for a Node CLI
// on Windows. The last line re-reads the arguments with `%*`.
const CMD_SHIM = (scriptFile: string): string =>
  [
    '@ECHO off',
    'GOTO start',
    ':find_dp0',
    'SET dp0=%~dp0',
    'EXIT /b',
    ':start',
    'SETLOCAL',
    'CALL :find_dp0',
    '',
    'IF EXIST "%dp0%\\node.exe" (',
    '  SET "_prog=%dp0%\\node.exe"',
    ') ELSE (',
    '  SET "_prog=node"',
    ')',
    '',
    `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${scriptFile}" %*`,
  ].join('\r\n')

/**
 * Writes a launcher for the Node script `bin/<scriptFile>` the way managers
 * install CLIs: a `#!/bin/sh` wrapper on POSIX, a cmd-shim `<name>.cmd` on
 * Windows.
 */
export const writeNodeShim = (
  bin: string,
  name: string,
  scriptFile: string,
): void => {
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(bin, `${name}.cmd`), CMD_SHIM(scriptFile))
    return
  }
  const launcher = path.join(bin, name)
  fs.writeFileSync(
    launcher,
    `#!/bin/sh\nexec node '${path.join(bin, scriptFile)}' "$@"\n`,
  )
  fs.chmodSync(launcher, 0o755)
}
