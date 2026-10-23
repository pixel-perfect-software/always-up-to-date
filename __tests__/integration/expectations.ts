import type { Manager } from './harness'

/**
 * What autd itself prints for the testRepos, derived from the repos' ranges and
 * the frozen release lines (see testRepos/README.md), never pasted from output.
 * Manager output is not asserted here, only autd's. Every deviation of a
 * manager from the derived values is a per-manager override below, with the
 * reason.
 */

export type Layout = 'single' | 'workspace' | 'catalogs'

export interface CheckRecord {
  current: string
  wanted: string
  workspaces?: { path: string; current: string; wanted: string }[]
}

export interface PlanRow {
  name: string
  workspace?: string
  current: string
  wanted: string
  target?: string
  updated: boolean
  reason?: unknown
}

export const isWorkspaceLayout = (layout: Layout): boolean =>
  layout !== 'single'

/** A held row: an exact pin or a range that already tops out at its latest. */
const heldBeyondRange = expect.stringMatching(
  /^(patch|minor|major) beyond the range$/,
)

/** `check --json`, projected to the fields that do not drift with `latest`. */
export const expectedCheck = (layout: Layout): Record<string, CheckRecord> => {
  if (!isWorkspaceLayout(layout)) {
    return {
      chalk: { current: '4.0.0', wanted: '4.1.2' },
      commander: { current: '11.0.0', wanted: '11.1.0' },
      dayjs: { current: '1.11.9', wanted: '1.11.9' },
      debug: { current: '4.3.1', wanted: '4.3.7' },
      ms: { current: '2.1.1', wanted: '2.1.3' },
      uuid: { current: '9.0.0', wanted: '9.0.1' },
    }
  }
  const at = (path: string, current: string, wanted: string) => ({
    path,
    current,
    wanted,
  })
  return {
    chalk: {
      current: '4.0.0',
      wanted: '4.1.2',
      workspaces: [at('packages/a', '4.0.0', '4.1.2')],
    },
    commander: {
      current: '11.0.0',
      wanted: '11.1.0',
      workspaces: [at('packages/b', '11.0.0', '11.1.0')],
    },
    dayjs: {
      current: '1.11.9',
      wanted: '1.11.9',
      workspaces: [at('.', '1.11.9', '1.11.9')],
    },
    debug: {
      current: '4.3.1',
      wanted: '4.3.7',
      workspaces: [at('packages/b', '4.3.1', '4.3.7')],
    },
    // The root's ~2.1.1 moves; packages/a pins 2.1.2, which is already its wanted.
    ms: {
      current: '2.1.1',
      wanted: '2.1.3',
      workspaces: [
        at('.', '2.1.1', '2.1.3'),
        at('packages/a', '2.1.2', '2.1.2'),
      ],
    },
    uuid: {
      current: '9.0.0',
      wanted: '9.0.1',
      workspaces: [at('packages/b', '9.0.0', '9.0.1')],
    },
  }
}

const row = (
  name: string,
  workspace: string | undefined,
  current: string,
  wanted: string,
  target?: string,
): PlanRow =>
  target === undefined
    ? {
        name,
        workspace,
        current,
        wanted,
        updated: false,
        reason: heldBeyondRange,
      }
    : {
        name,
        workspace,
        current,
        wanted,
        target,
        updated: true,
        reason: undefined,
      }

/** `update --dry-run --json`: sorted by name, then workspace. */
export const expectedPlan = (layout: Layout): PlanRow[] =>
  isWorkspaceLayout(layout)
    ? [
        row('chalk', 'packages/a', '4.0.0', '4.1.2', '4.1.2'),
        row('commander', 'packages/b', '11.0.0', '11.1.0', '11.1.0'),
        row('dayjs', '.', '1.11.9', '1.11.9'),
        row('debug', 'packages/b', '4.3.1', '4.3.7', '4.3.7'),
        row('ms', '.', '2.1.1', '2.1.3', '2.1.3'),
        row('ms', 'packages/a', '2.1.2', '2.1.2'),
        row('uuid', 'packages/b', '9.0.0', '9.0.1', '9.0.1'),
      ]
    : [
        row('chalk', undefined, '4.0.0', '4.1.2', '4.1.2'),
        row('commander', undefined, '11.0.0', '11.1.0', '11.1.0'),
        row('dayjs', undefined, '1.11.9', '1.11.9'),
        row('debug', undefined, '4.3.1', '4.3.7', '4.3.7'),
        row('ms', undefined, '2.1.1', '2.1.3', '2.1.3'),
        row('uuid', undefined, '9.0.0', '9.0.1', '9.0.1'),
      ]

/**
 * pnpm, in a workspace, dedupes the root's `ms` (`~2.1.1`, so 2.1.3 is allowed)
 * onto 2.1.2, the version packages/a pins and the lockfile already holds:
 * `pnpm update -r ms` prints `- ms 2.1.1` / `+ ms 2.1.2` and writes `~2.1.2`,
 * with autd out of the loop. autd reports the move as not applied (it checks
 * what was installed). Observed with pnpm 12.14.0, 2026-10-23.
 */
const PNPM_MS_DEDUPED: PlanRow = {
  name: 'ms',
  workspace: '.',
  current: '2.1.1',
  wanted: '2.1.3',
  updated: false,
  reason: 'not applied by pnpm (installed 2.1.2)',
}

/**
 * `update --json` is the plan, except where a manager leaves a package where it
 * was. Keyed by `<manager>-<layout>`; rows replace the plan's by name and workspace.
 */
const UPDATE_OVERRIDES: Record<string, PlanRow[]> = {
  'pnpm-workspace': [PNPM_MS_DEDUPED],
  'pnpm-catalogs': [PNPM_MS_DEDUPED],
}

export const expectedUpdate = (manager: Manager, layout: Layout): PlanRow[] => {
  const overrides = UPDATE_OVERRIDES[`${manager}-${layout}`] ?? []
  return expectedPlan(layout).map(
    (planned) =>
      overrides.find(
        (o) => o.name === planned.name && o.workspace === planned.workspace,
      ) ?? planned,
  )
}

const FLOORS: Record<string, string> = {
  chalk: '4.1.2',
  commander: '11.1.0',
  debug: '4.3.7',
  ms: '2.1.3',
  uuid: '9.0.1',
}

/** The floors a manager that rewrites ranges writes for the packages that moved. */
export const floorsFor = (
  manager: Manager,
  layout: Layout,
): Record<string, string> =>
  UPDATE_OVERRIDES[`${manager}-${layout}`]?.some((o) => o.name === 'ms')
    ? { ...FLOORS, ms: '2.1.2' } // see PNPM_MS_DEDUPED
    : FLOORS

/** `^4.0.0` -> `^4.1.2`; exact pins and `catalog:` references stay. */
export const raiseFloors = (
  map: Record<string, string>,
  floors: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(
    Object.entries(map).map(([name, spec]) => {
      const prefix = /^([~^])\d+\.\d+\.\d+$/.exec(spec)?.[1]
      return [name, prefix && floors[name] ? `${prefix}${floors[name]}` : spec]
    }),
  )

/**
 * Whether the manager rewrites the manifest ranges on `update` (pnpm and bun
 * raise the floors) or leaves package.json alone and only the lockfile moves
 * (npm, yarn v1, berry).
 */
export const rewritesRanges = (manager: Manager): boolean =>
  manager === 'pnpm' || manager === 'bun'
