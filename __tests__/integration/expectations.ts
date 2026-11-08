import type { Manager } from './harness'

/**
 * What autd itself prints for the testRepos, derived from the repos' ranges and
 * the frozen release lines (see testRepos/README.md), never pasted from output.
 * Manager output is not asserted here, only autd's. Every deviation of a
 * manager from the derived values is a per-manager override below, with the
 * reason.
 */

export type Layout = 'single' | 'workspace' | 'catalogs'

/** A row of the `--json` document (#201), reduced to the fields that do not drift with `latest`. */
export interface PlanRow {
  name: string
  workspace: string
  current: string
  wanted: string
  target: string | null
  outcome: string
  reason: { code: string; message: unknown }
}

export const isWorkspaceLayout = (layout: Layout): boolean =>
  layout !== 'single'

/** A held row: an exact pin or a range that already tops out at its latest. */
const heldBeyondRange = expect.stringMatching(
  /^(patch|minor|major) beyond the range$/,
)

const row = (
  name: string,
  workspace: string,
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
        target: null,
        outcome: 'held',
        reason: { code: 'outside-range', message: heldBeyondRange },
      }
    : {
        name,
        workspace,
        current,
        wanted,
        target,
        outcome: 'update',
        reason: { code: 'within-range', message: 'within range' },
      }

/** `check --json` and `update --dry-run --json` print the same rows: sorted by name, then workspace. */
export const expectedPlan = (layout: Layout): PlanRow[] =>
  isWorkspaceLayout(layout)
    ? [
        row('chalk', 'packages/a', '4.0.0', '4.1.2', '4.1.2'),
        row('commander', 'packages/b', '11.0.0', '11.1.0', '11.1.0'),
        row('dayjs', '.', '1.11.9', '1.11.9'),
        row('debug', 'packages/b', '4.3.1', '4.3.7', '4.3.7'),
        row('kleur', 'packages/b', '3.0.0', '3.0.3', '3.0.3'),
        row('ms', '.', '2.1.1', '2.1.3', '2.1.3'),
        row('ms', 'packages/a', '2.1.2', '2.1.2'),
      ]
    : [
        row('chalk', '.', '4.0.0', '4.1.2', '4.1.2'),
        row('commander', '.', '11.0.0', '11.1.0', '11.1.0'),
        row('dayjs', '.', '1.11.9', '1.11.9'),
        row('debug', '.', '4.3.1', '4.3.7', '4.3.7'),
        row('kleur', '.', '3.0.0', '3.0.3', '3.0.3'),
        row('ms', '.', '2.1.1', '2.1.3', '2.1.3'),
      ]

/**
 * The floors a manager that rewrites ranges writes for the packages that moved.
 * Every manager applies the whole plan: pnpm 12.14.0 deduped the workspace
 * root's `ms` (`~2.1.1`) onto packages/a's 2.1.2 and wrote `~2.1.2`; pnpm
 * 12.16.1 moves it to 2.1.3 like the others.
 */
export const FLOORS: Record<string, string> = {
  chalk: '4.1.2',
  commander: '11.1.0',
  debug: '4.3.7',
  kleur: '3.0.3',
  ms: '2.1.3',
}

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

/**
 * Whether the manager raises a catalog entry's floor when it moves the
 * package. bun 1.4.4's `update --filter '*'` installs the in-range version
 * but leaves `catalog`/`catalogs` ranges as written (`^4.0.0` stays), while
 * it raises the floors in package.json. pnpm 12 raises both.
 */
export const rewritesCatalogRanges = (manager: Manager): boolean =>
  manager !== 'bun'

/** The workspace members of the `workspace` and `catalogs` layouts. */
export type Member = 'packages/a' | 'packages/b'

/**
 * `check --json` and `update --dry-run --json` from a member (#123), with `beyondRange: "patch"` set in
 * the member's own config (the matrix writes it for packages/a): that
 * member's rows of the root run's plan, except that packages/a's pinned
 * `ms 2.1.2` may move a patch past its range, to the latest, 2.1.3.
 */
export const expectedMemberPlan = (layout: Layout, member: Member): PlanRow[] =>
  expectedPlan(layout)
    .filter((planned) => planned.workspace === member)
    .map((planned) =>
      member === 'packages/a' && planned.name === 'ms'
        ? {
            ...row('ms', member, '2.1.2', '2.1.2', '2.1.3'),
            reason: {
              code: 'past-range',
              message: 'past its range, "beyondRange": "patch"',
            },
          }
        : planned,
    )
