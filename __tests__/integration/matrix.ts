import {
  type CheckRecord,
  expectedCheck,
  expectedPlan,
  expectedUpdate,
  floorsFor,
  isWorkspaceLayout,
  type Layout,
  type PlanRow,
  raiseFloors,
  rewritesRanges,
} from './expectations'
import {
  assertBuilt,
  cleanup,
  LAYOUTS,
  type Manager,
  managerEnv,
  prepareRepo,
  readCatalogs,
  readDependencies,
  runCli,
  selectedManagers,
} from './harness'

type Maps = Record<string, Record<string, string>>

/** autd's rows, reduced to the fields the matrix pins and sorted by name, then workspace. */
const projectRows = (rows: unknown): PlanRow[] =>
  (rows as (PlanRow & { latest: string })[])
    .map(({ name, workspace, current, wanted, target, updated, reason }) => ({
      name,
      workspace,
      current,
      wanted,
      target,
      updated,
      reason,
    }))
    .sort(
      (a, b) =>
        a.name.localeCompare(b.name) ||
        (a.workspace ?? '').localeCompare(b.workspace ?? ''),
    )

const projectCheck = (
  record: unknown,
  layout: Layout,
): Record<string, CheckRecord> =>
  Object.fromEntries(
    Object.entries(record as Record<string, CheckRecord>).map(
      ([name, { current, wanted, workspaces }]) => [
        name,
        isWorkspaceLayout(layout)
          ? {
              current,
              wanted,
              workspaces: workspaces?.map(({ path, current, wanted }) => ({
                path,
                current,
                wanted,
              })),
            }
          : { current, wanted },
      ],
    ),
  )

/**
 * The describe/it bodies shared by every manager: one `describe` per repo of
 * the manager, which prepares a temp copy once and walks it through check,
 * dry run, update, the manifests afterwards and a second check. Managers that
 * are not selected (AUTD_INTEGRATION_PM) are skipped.
 */
export const runMatrix = (manager: Manager): void => {
  const run = selectedManagers().includes(manager) ? describe : describe.skip

  run(manager, () => {
    let restoreEnv: () => void

    beforeAll(() => {
      assertBuilt()
      restoreEnv = managerEnv()
    })
    afterAll(() => restoreEnv())

    for (const layout of LAYOUTS[manager] as readonly Layout[]) {
      describe(`${manager}-${layout}`, () => {
        let cwd: string
        let before: { dependencies: Record<string, Maps>; catalogs: Maps }
        let moved: PlanRow[] = []

        const manifests = () => ({
          dependencies: readDependencies(cwd),
          catalogs: readCatalogs(cwd),
        })

        beforeAll(async () => {
          ;({ cwd } = await prepareRepo(`${manager}-${layout}`))
          before = manifests()
        })
        afterAll(() => cleanup(cwd))

        it('check --json reports the installed minimums against the wanted maxima', async () => {
          expect(
            projectCheck(await runCli(cwd, ['check', '--json']), layout),
          ).toEqual(expectedCheck(layout))
        })

        it('update --dry-run --json plans the moves and holds the pins', async () => {
          expect(
            projectRows(await runCli(cwd, ['update', '--dry-run', '--json'])),
          ).toEqual(expectedPlan(layout))
          expect(manifests()).toEqual(before)
        })

        it('update --json applies the plan', async () => {
          const rows = projectRows(await runCli(cwd, ['update', '--json']))
          expect(rows).toEqual(expectedUpdate(manager, layout))
          moved = rows.filter((r) => r.updated)
        })

        it('leaves the manifests as the manager rewrites them', () => {
          const after = manifests()
          const floors = floorsFor(manager, layout)
          if (!rewritesRanges(manager)) {
            expect(after).toEqual(before)
            return
          }
          expect(after.dependencies).toEqual(
            Object.fromEntries(
              Object.entries(before.dependencies).map(([dir, fields]) => [
                dir,
                Object.fromEntries(
                  Object.entries(fields).map(([field, map]) => [
                    field,
                    raiseFloors(map, floors),
                  ]),
                ),
              ]),
            ),
          )
          expect(after.catalogs).toEqual(
            Object.fromEntries(
              Object.entries(before.catalogs).map(([name, map]) => [
                name,
                raiseFloors(map, floors),
              ]),
            ),
          )
        })

        it('check --json afterwards lists no moved package below its target and keeps the pins', async () => {
          const record = (await runCli(cwd, ['check', '--json'])) as Record<
            string,
            CheckRecord
          >

          for (const { name, workspace, target } of moved) {
            const entry = record[name]
            if (!entry) continue
            const current = entry.workspaces
              ? entry.workspaces.find((w) => w.path === workspace)?.current
              : entry.current
            if (current !== undefined)
              expect({ name, current }).toEqual({ name, current: target })
          }

          expect(record.dayjs.current).toBe('1.11.9')
          if (isWorkspaceLayout(layout)) {
            expect(
              record.ms.workspaces?.find((w) => w.path === 'packages/a')
                ?.current,
            ).toBe('2.1.2')
          }
        })
      })
    }
  })
}
