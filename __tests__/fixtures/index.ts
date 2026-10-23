import fs from 'fs'
import path from 'path'
import type { ManagerAdapter } from '@/managers'
import type { Project } from '@/project'
import type { AlwaysUpToDateConfig, OutdatedEntry } from '@/types'
import { DEFAULT_CONFIG } from '@/utils/config'

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

/** A project for the pipeline: the default config with `config` laid over it. */
export const projectFor = (
  adapter: ManagerAdapter,
  cwd: string,
  config: Partial<AlwaysUpToDateConfig> = {},
): Project => ({ adapter, cwd, config: { ...DEFAULT_CONFIG, ...config } })

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
