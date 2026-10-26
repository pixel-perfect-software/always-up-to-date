import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm from '@/managers/pnpm'
import yarn from '@/managers/yarn'
import { check, plan, update } from '@/pipeline'
import type { AlwaysUpToDateConfig } from '@/types'
import { capturedRegistry, installPackages, projectFor } from './fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
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
    if (operation === 'check') return json(await check(project))
    if (operation === 'plan') {
      return json(await plan(project, await check(project)))
    }
    return json(await update(project))
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
      for (const output of printed) expect(output).toBe(printed[0])
    },
  )
})
