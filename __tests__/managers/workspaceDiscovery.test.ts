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
  exitError,
  projectFor,
  readFixture,
  writeWorkspaceProject,
} from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { runProcess } from '@/utils'

const mockedRunProcess = jest.mocked(runProcess)
const mockedPrintRows = jest.mocked(logger.printOutdatedRows)

// The record `check` returns for the evidence workspace, whichever manager reported it.
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

describe.each([
  {
    pm: 'npm',
    adapter: npm,
    report: 'npm/outdated-workspace.stdout',
    compatible: undefined,
    exitsOne: true,
    pnpm: false,
  },
  {
    pm: 'pnpm',
    adapter: pnpm,
    report: 'pnpm/outdated-workspace.stdout',
    compatible: 'pnpm/outdated-workspace-compatible.stdout',
    exitsOne: true,
    pnpm: true,
  },
  {
    pm: 'yarn',
    adapter: yarn,
    report: 'yarn/v1-outdated-workspace.stdout',
    compatible: undefined,
    exitsOne: true,
    pnpm: false,
  },
  {
    pm: 'bun',
    adapter: bun,
    report: 'bun/outdated-workspace.stdout',
    compatible: undefined,
    exitsOne: false,
    pnpm: false,
  },
] as const)(
  'workspace discovery with $pm',
  ({ pm, adapter, report, compatible, exitsOne, pnpm: usesPnpm }) => {
    let cwd: string

    beforeEach(() => {
      cwd = fs.mkdtempSync(path.join(os.tmpdir(), `autd-ws-discovery-${pm}-`))
      writeWorkspaceProject(cwd, { pnpm: usesPnpm })
      mockedRunProcess.mockImplementation(async (_file, args) => {
        // The temp dir goes into JSON strings: escaped, since a Windows
        // path holds backslashes.
        const stdout = readFixture(
          compatible && args.includes('--compatible') ? compatible : report,
        ).replaceAll('/project', JSON.stringify(cwd).slice(1, -1))
        if (!exitsOne) return { stdout, stderr: '' }
        throw exitError(1, stdout, '')
      })
    })

    afterEach(() => {
      fs.rmSync(cwd, { recursive: true, force: true })
    })

    it('returns each package once, with its manifests', async () => {
      const outdated = await check(projectFor(adapter, cwd))

      expect(outdated).toEqual(EXPECTED)
    })

    it('prints one row per manifest, each carrying its workspace', async () => {
      await check(projectFor(adapter, cwd))

      const rows = mockedPrintRows.mock.calls.flatMap(([printed]) => printed)
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

    if (pm === 'npm') {
      it('asks for the owning manifest and drops --workspaces', async () => {
        await check(projectFor(adapter, cwd))

        expect(mockedRunProcess.mock.calls[0][1]).toEqual([
          'outdated',
          '--json',
          '--long',
        ])
      })
    }

    if (pm === 'bun') {
      it('filters on every workspace', async () => {
        await check(projectFor(adapter, cwd))

        expect(mockedRunProcess.mock.calls[0][1]).toEqual([
          'outdated',
          '--filter',
          '*',
        ])
      })
    }
  },
)

describe.each([
  {
    pm: 'yarn',
    adapter: yarn,
    report: 'yarn/v1-outdated-workspace-unnamed-root.stdout',
  },
  {
    pm: 'bun',
    adapter: bun,
    report: 'bun/outdated-workspace-unnamed-root.stdout',
  },
] as const)('$pm with a root that has no name', ({ pm, adapter, report }) => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), `autd-ws-unnamed-${pm}-`))
    writeWorkspaceProject(cwd, { rootName: null })
    mockedRunProcess.mockImplementation(async () => {
      const stdout = readFixture(report)
      if (pm === 'bun') return { stdout, stderr: '' }
      throw exitError(1, stdout, '')
    })
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it("attributes the unnamed root's rows to the root", async () => {
    const outdated = await check(projectFor(adapter, cwd))

    expect(outdated.dayjs.workspaces?.map((w) => w.path)).toEqual([
      '.',
      'packages/b',
    ])
  })
})
