import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm from '@/managers/pnpm'
import yarn from '@/managers/yarn'
import { check } from '@/pipeline'
import { logger } from '@/utils'
import {
  capturedRegistry,
  installPackages,
  projectFor,
  writeWorkspaceProject,
} from '../fixtures'

jest.mock('@/utils/logger')

const mockedReport = jest.mocked(logger.report)

// When the workspace fixtures were captured, so no version drifts with the registry.
const AS_OF = '2026-10-23T16:38:12-03:00'

/** What the install left in the evidence workspace: dayjs, ms and debug hoisted, ms 2.1.2 in packages/a. */
const installEvidenceWorkspace = (cwd: string): void => {
  installPackages(cwd, '.', { dayjs: '1.11.9', ms: '2.1.1', debug: '4.3.1' })
  installPackages(cwd, 'packages/a', { ms: '2.1.2' })
}

const evidenceRegistry = () =>
  capturedRegistry(['dayjs', 'ms', 'debug'], { asOf: AS_OF })

// The record `check` returns for the evidence workspace, whichever manager is in use.
const EXPECTED = {
  dayjs: {
    name: 'dayjs',
    current: '1.11.9',
    wanted: '1.11.9',
    latest: '1.11.23',
    workspaces: [
      { path: '.', current: '1.11.9', wanted: '1.11.9' },
      { path: 'packages/b', current: '1.11.9', wanted: '1.11.23' },
    ],
  },
  debug: {
    name: 'debug',
    current: '4.3.1',
    wanted: '4.3.7',
    latest: '4.4.3',
    workspaces: [{ path: 'packages/b', current: '4.3.1', wanted: '4.3.7' }],
  },
  ms: {
    name: 'ms',
    current: '2.1.1',
    wanted: '2.1.3',
    latest: '2.1.3',
    workspaces: [
      { path: '.', current: '2.1.1', wanted: '2.1.3' },
      { path: 'packages/a', current: '2.1.2', wanted: '2.1.2' },
    ],
  },
}

const ADAPTERS = [
  { pm: 'npm', adapter: npm, pnpm: false },
  { pm: 'pnpm', adapter: pnpm, pnpm: true },
  { pm: 'yarn', adapter: yarn, pnpm: false },
  { pm: 'bun', adapter: bun, pnpm: false },
] as const

describe.each(ADAPTERS)(
  'workspace discovery with $pm',
  ({ pm, adapter, pnpm: usesPnpm }) => {
    let cwd: string

    beforeEach(() => {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), `autd-ws-discovery-${pm}-`))
      writeWorkspaceProject(cwd, { pnpm: usesPnpm })
      installEvidenceWorkspace(cwd)
    })

    afterEach(() => {
      fs.rmSync(cwd, { recursive: true, force: true })
    })

    it('returns each package once, with its manifests', async () => {
      const outdated = await check(
        projectFor(adapter, cwd, {}, evidenceRegistry()),
      )

      expect(outdated).toEqual(EXPECTED)
    })

    it('prints one row per manifest, each carrying its workspace', async () => {
      await check(projectFor(adapter, cwd, {}, evidenceRegistry()))

      const rows = mockedReport.mock.calls.flatMap(([results]) => results)
      expect(
        rows.map((row) => [row.name, row.workspace, row.current]).sort(),
      ).toEqual([
        ['dayjs', '.', '1.11.9'],
        ['dayjs', 'packages/b', '1.11.9'],
        ['debug', 'packages/b', '4.3.1'],
        ['ms', '.', '2.1.1'],
        ['ms', 'packages/a', '2.1.2'],
      ])
    })
  },
)

describe.each(ADAPTERS)(
  '$pm with a root that has no name',
  ({ pm, adapter, pnpm: usesPnpm }) => {
    let cwd: string

    beforeEach(() => {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), `autd-ws-unnamed-${pm}-`))
      writeWorkspaceProject(cwd, { rootName: null, pnpm: usesPnpm })
      installEvidenceWorkspace(cwd)
    })

    afterEach(() => {
      fs.rmSync(cwd, { recursive: true, force: true })
    })

    it("attributes the unnamed root's rows to the root", async () => {
      const outdated = await check(
        projectFor(adapter, cwd, {}, evidenceRegistry()),
      )

      expect(outdated.dayjs.workspaces?.map((w) => w.path)).toEqual([
        '.',
        'packages/b',
      ])
    })
  },
)
