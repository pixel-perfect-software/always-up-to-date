import fs from 'fs'
import path from 'path'
import {
  type CheckRecord,
  expectedCheck,
  expectedMemberCheck,
  expectedMemberPlan,
  expectedPlan,
  expectedUpdate,
  floorsFor,
  isWorkspaceLayout,
  type Layout,
  type Member,
  type PlanRow,
  raiseFloors,
  rewritesCatalogRanges,
  rewritesRanges,
} from './expectations'
import {
  assertBuilt,
  cleanup,
  frozenInstall,
  LAYOUTS,
  type Manager,
  managerEnv,
  prepareRepo,
  readCatalogs,
  readDependencies,
  runCli,
  runCliExpectingFailure,
  runCliThroughTripwire,
  runCliWithoutManagers,
  selectedManagers,
  snapshotFiles,
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
    let restoreEnv: (() => void) | undefined

    beforeAll(() => {
      assertBuilt()
      restoreEnv = managerEnv(manager)
    })
    afterAll(() => restoreEnv?.())

    for (const layout of LAYOUTS[manager] as readonly Layout[]) {
      describe(`${manager}-${layout}`, () => {
        // Empty until prepareRepo returns: a failed setup has nothing to clean up.
        let cwd = ''
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
        afterAll(() => {
          if (cwd) cleanup(cwd)
        })

        // Berry still discovers through `yarn info` (#107); the rest read the
        // manifests, node_modules and the registry, so they need no manager.
        it('check --json reports the installed minimums against the wanted maxima', async () => {
          const check = manager === 'berry' ? runCli : runCliWithoutManagers
          expect(
            projectCheck(await check(cwd, ['check', '--json']), layout),
          ).toEqual(expectedCheck(layout))
        })

        // Berry still asks its manager (#107). The rest answer the repeat from
        // autd's cache, and a proxy that records every request proves it.
        if (manager !== 'berry') {
          it('check --json again within the TTL asks no registry', async () => {
            const first = await runCliWithoutManagers(cwd, ['check', '--json'])

            const { output, seen } = await runCliThroughTripwire(cwd, [
              'check',
              '--json',
            ])

            expect(output).toEqual(first)
            expect(seen).toEqual([])

            // The tripwire is live: the same run without the cache is seen.
            const bypassed = await runCliThroughTripwire(cwd, [
              'check',
              '--json',
              '--no-cache',
            ])
            expect(bypassed.output).toEqual(first)
            expect(bypassed.seen.length).toBeGreaterThan(0)
          })
        }

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
            rewritesCatalogRanges(manager)
              ? Object.fromEntries(
                  Object.entries(before.catalogs).map(([name, map]) => [
                    name,
                    raiseFloors(map, floors),
                  ]),
                )
              : before.catalogs,
          )
        })

        // The manager's own check that the lockfile still agrees with the manifests.
        it('a frozen install passes after the update', async () => {
          await frozenInstall(manager, cwd)
        })

        it('check --json afterwards lists no moved package below its target and keeps the pins', async () => {
          const record = (await runCli(cwd, ['check', '--json'])) as Record<
            string,
            CheckRecord
          >

          // Every workspace the record names is one of the repo's manifests:
          // a format change shows up here instead of as a silent skip below.
          const manifestPaths = Object.keys(readDependencies(cwd))
          for (const entry of Object.values(record)) {
            for (const { path } of entry.workspaces ?? []) {
              expect(manifestPaths).toContain(path)
            }
          }

          // A moved package is either gone from the record (no longer
          // outdated) or, where it is listed, at its target.
          for (const { name, workspace, target } of moved) {
            const entry = record[name]
            if (!entry) continue
            const row = entry.workspaces
              ? entry.workspaces.find((w) => w.path === workspace)
              : entry
            if (row)
              expect({ name, current: row.current }).toEqual({
                name,
                current: target,
              })
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

/**
 * Runs from a workspace member (#123), on a fresh copy of each workspace
 * layout. `check` and `update --dry-run` stay scoped to the member, and every
 * writing `update` is refused, with nothing run and no file touched.
 */
export const runMemberMatrix = (manager: Manager): void => {
  const run = selectedManagers().includes(manager) ? describe : describe.skip

  run(`${manager} member runs`, () => {
    let restoreEnv: (() => void) | undefined

    beforeAll(() => {
      assertBuilt()
      restoreEnv = managerEnv(manager)
    })
    afterAll(() => restoreEnv?.())

    for (const layout of LAYOUTS[manager] as readonly Layout[]) {
      if (!isWorkspaceLayout(layout)) continue

      describe(`${manager}-${layout}`, () => {
        let cwd = ''
        let before: Record<string, string>
        const dir = (member: string) => path.join(cwd, ...member.split('/'))
        // Berry still discovers through `yarn info` (#107).
        const check = manager === 'berry' ? runCli : runCliWithoutManagers

        beforeAll(async () => {
          ;({ cwd } = await prepareRepo(`${manager}-${layout}`))
          // packages/a has a config of its own; packages/b falls back to the root's (none).
          fs.writeFileSync(
            path.join(dir('packages/a'), '.always-up-to-date.json'),
            '{"beyondRange":"patch"}\n',
          )
          fs.mkdirSync(path.join(dir('packages/a'), 'src'))
          before = snapshotFiles(cwd)
        })
        afterAll(() => {
          if (cwd) cleanup(cwd)
        })

        it.each(['packages/a', 'packages/a/src'])(
          'check --json from %s lists packages/a only',
          async (from) => {
            expect(
              projectCheck(await check(dir(from), ['check', '--json']), layout),
            ).toEqual(expectedMemberCheck(layout, 'packages/a'))
          },
        )

        it('check --json from packages/b lists commander, debug and kleur', async () => {
          const record = projectCheck(
            await check(dir('packages/b'), ['check', '--json']),
            layout,
          )
          expect(record).toEqual(expectedMemberCheck(layout, 'packages/b'))
          expect(Object.keys(record)).toEqual(['commander', 'debug', 'kleur'])
        })

        if (manager === 'berry') {
          it('check --json --pm yarn from packages/a takes the same path', async () => {
            expect(
              projectCheck(
                await runCli(dir('packages/a'), [
                  'check',
                  '--json',
                  '--pm',
                  'yarn',
                ]),
                layout,
              ),
            ).toEqual(expectedMemberCheck(layout, 'packages/a'))
          })
        }

        it.each(['packages/a', 'packages/b'] as Member[])(
          'update --dry-run --json from %s plans that member and writes nothing',
          async (member) => {
            expect(
              projectRows(
                await runCli(dir(member), ['update', '--dry-run', '--json']),
              ),
            ).toEqual(expectedMemberPlan(layout, member))
            expect(snapshotFiles(cwd)).toEqual(before)
          },
        )

        it.each(['packages/a', 'packages/a/src', 'packages/b'])(
          'update --json from %s is refused and writes nothing',
          async (from) => {
            const output = (await runCliExpectingFailure(dir(from), [
              'update',
              '--json',
            ])) as {
              error: { step: string; message: string; manifestWritten: boolean }
            }

            expect(output.error.step).toBe('apply')
            expect(output.error.manifestWritten).toBe(false)
            expect(output.error.message).toContain(`run autd update in ${cwd}`)
            expect(snapshotFiles(cwd)).toEqual(before)
          },
        )
      })
    }
  })
}
