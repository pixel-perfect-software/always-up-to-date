import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm from '@/managers/pnpm'
import yarn from '@/managers/yarn'
import { findOutdated, plan, update } from '@/pipeline'
import type { AlwaysUpToDateConfig } from '@/types'
import { planDocument } from '@/utils/jsonDocument'
import packageJson from '../package.json'
import { capturedRegistry, installPackages, projectFor } from './fixtures'
import { validateOutput } from './fixtures/outputSchema'

jest.mock('@/utils/logger')
jest.mock('@/utils/runProcess', () => ({
  ...jest.requireActual('@/utils/runProcess'),
  runProcess: jest.fn(),
}))

const manifest = {
  dependencies: {
    zod: '3.x',
    express: '>=4.18.2 <5.0.0',
    semver: '~7.5.0 || ~7.6.0',
    dj: 'npm:dayjs@1.11.9',
    ms: '*',
  },
}

// What the manager left in node_modules when the snapshot was captured.
const INSTALLED = {
  dj: '1.11.9',
  express: '4.22.3',
  semver: '7.6.3',
  zod: '3.25.76',
  ms: '2.1.3',
}

// When the snapshot was captured, so no version drifts with the registry.
const AS_OF = '2026-10-23T16:38:12-03:00'

const json = (value: unknown): string => JSON.stringify(value, null, 2)

type Operation = 'check' | 'plan' | 'update'

/** `plan` is `update --dry-run --json`. */
const run = async (
  adapter: typeof npm,
  config: Partial<AlwaysUpToDateConfig>,
  operation: Operation,
): Promise<string> => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-single-json-'))
  try {
    fs.writeFileSync(path.join(cwd, 'package.json'), JSON.stringify(manifest))
    installPackages(cwd, '.', INSTALLED)
    const registry = capturedRegistry(
      ['zod', 'express', 'semver', 'dayjs', 'ms'],
      { asOf: AS_OF },
    )
    // The manager moves each package to its target, so the post-apply check keeps it updated.
    const apply = jest.fn(async (_run, dir: string, { beyondRange }) =>
      installPackages(dir, '.', beyondRange),
    )
    const project = projectFor({ ...adapter, apply }, cwd, config, registry)
    // check --json plans, as the action does: findOutdated, then plan.
    const results =
      operation === 'update'
        ? await update(project)
        : await plan(project, await findOutdated(project))
    const document = planDocument({
      command: operation === 'check' ? 'check' : 'update',
      phase: operation === 'update' ? 'applied' : 'plan',
      manager: adapter.name,
      results,
    })
    validateOutput(document)
    // The release PR bumps the version; the snapshot must not move with it.
    expect(document.autd).toBe(packageJson.version)
    return json({ ...document, autd: '<package version>' })
  } finally {
    fs.rmSync(cwd, { recursive: true, force: true })
  }
}

const CONFIGS = [
  { label: 'default config', config: {} },
  { label: 'beyondRange major', config: { beyondRange: 'major' as const } },
]
const ADAPTERS = [
  { pm: 'npm', adapter: npm },
  { pm: 'pnpm', adapter: pnpm },
  { pm: 'yarn', adapter: yarn },
  { pm: 'bun', adapter: bun },
] as const

/**
 * Pins the exact bytes single-package projects print with `--json`, so no
 * later change to workspace handling can alter them. Never update this
 * snapshot to make a workspace change pass.
 *
 * #106 reviewed it once: discovery stopped passing the managers' own
 * `outdated` output through, so the input is the registry captures as of the
 * date the snapshot was taken, plus a written node_modules, and all four
 * managers print the same bytes.
 *
 * #201 reviewed it once: 4.0.0's versioned document.
 */
describe.each(ADAPTERS)('$pm single-package JSON', ({ adapter }) => {
  describe.each(CONFIGS)('$label', ({ config }) => {
    it.each(['check', 'plan', 'update'] as const)('%s', async (operation) => {
      expect(await run(adapter, config, operation)).toMatchSnapshot()
    })
  })
})

describe.each(CONFIGS)('single-package JSON, $label', ({ config }) => {
  it.each(['check', 'plan', 'update'] as const)(
    'is identical for npm, pnpm, yarn and bun: %s',
    async (operation) => {
      const printed = await Promise.all(
        ADAPTERS.map(({ adapter }) => run(adapter, config, operation)),
      )
      // Only `manager` differs; the rows are the same bytes.
      const rows = printed.map((output) => json(JSON.parse(output).rows))
      for (const output of rows) expect(output).toBe(rows[0])
    },
  )
})

describe.each(CONFIGS)('check and update --dry-run, $label', ({ config }) => {
  it('print the same rows', async () => {
    const rowsOf = async (operation: Operation) =>
      JSON.parse(await run(npm, config, operation)).rows
    expect(await rowsOf('check')).toEqual(await rowsOf('plan'))
  })
})
