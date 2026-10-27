import fs from 'fs'
import os from 'os'
import path from 'path'
import bun from '@/managers/bun'
import npm from '@/managers/npm'
import pnpm from '@/managers/pnpm'
import yarn from '@/managers/yarn'
import { check } from '@/pipeline'
import { filterPackages } from '@/utils'
import { capturedRegistry, installPackages, projectFor } from '../fixtures'

jest.mock('@/utils/logger')

/**
 * What `npm update` installed on the mixed-range benchmark project (12 of 40
 * dependencies on ^ or ~, the rest exact pins), observed on a real run.
 */
const NPM_UPDATE_APPLIES = {
  axios: '1.20.0',
  dayjs: '1.11.23',
  debug: '4.3.7',
  express: '4.22.3',
  lodash: '4.18.1',
  next: '14.0.4',
  qs: '6.16.1',
  react: '18.3.1',
  'react-dom': '18.3.1',
  semver: '7.5.4',
  typescript: '5.9.3',
  zod: '3.25.76',
}

// The benchmark projects' manifests, committed as package.fixture.json
// (bench/pinned: every dependency an exact pin; bench/ranges: 12 of them on
// ^ or ~). Installs sit at the pinned
// versions, which are the ranges' minimums.
const benchDependencies = (project: 'ranges' | 'pinned') =>
  JSON.parse(
    fs.readFileSync(
      path.join(__dirname, '..', '..', 'bench', project, 'package.fixture.json'),
      'utf8',
    ),
  ).dependencies as Record<string, string>

const RANGED = Object.keys(NPM_UPDATE_APPLIES)
// ms is an exact pin in both projects: a pin is held whatever is newer.
const NAMES = [...RANGED, 'ms']

// When the fixtures behind NPM_UPDATE_APPLIES were observed.
const AS_OF = '2026-10-23T10:04:28-03:00'

describe.each([
  ['npm', npm],
  ['pnpm', pnpm],
  ['yarn', yarn],
  ['bun', bun],
] as const)('%s, default config', (pm, adapter) => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), `autd-within-range-${pm}-`))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  const proposals = async (layout: 'ranges' | 'pinned') => {
    const declared = benchDependencies(layout)
    const pinned = benchDependencies('pinned')
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        dependencies: Object.fromEntries(
          NAMES.map((name) => [name, declared[name]]),
        ),
      }),
    )
    installPackages(
      cwd,
      '.',
      Object.fromEntries(NAMES.map((name) => [name, pinned[name]])),
    )
    const project = projectFor(
      adapter,
      cwd,
      {},
      capturedRegistry(NAMES, { asOf: AS_OF }),
    )
    const outdated = await check(project)
    const results = await filterPackages(outdated, {
      config: project.config,
      cwd,
      registry: project.registry,
    })
    return Object.fromEntries(
      results.filter((r) => r.updated).map((r) => [r.name, r.target]),
    )
  }

  it('proposes exactly the set npm update applies on the mixed-range project', async () => {
    expect(await proposals('ranges')).toEqual(NPM_UPDATE_APPLIES)
  })

  it('proposes nothing when every dependency is an exact pin', async () => {
    expect(await proposals('pinned')).toEqual({})
  })
})
