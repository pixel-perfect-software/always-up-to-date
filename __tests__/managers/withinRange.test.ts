import BunManager from '@/managers/bun'
import NPMManager from '@/managers/npm'
import PNPMManager from '@/managers/pnpm'
import YarnManager from '@/managers/yarn'
import { exitError, readFixture } from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils/config')
jest.mock('@/utils/registry', () => ({
  clearRegistryCache: jest.fn(),
  fetchReleaseTimes: jest.fn(),
}))
jest.mock('@/utils', () => ({
  ...jest.requireActual('@/utils'),
  runProcess: jest.fn(),
}))

import { filterPackages, runProcess } from '@/utils'

const mockedRunProcess = jest.mocked(runProcess)

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

// Real `outdated` output for each manager, keyed by benchmark project.
const outdatedOutput = {
  npm: { ranges: 'npm/outdated-ranges.stdout', pinned: 'npm/outdated.stdout' },
  pnpm: {
    ranges: 'pnpm/outdated-ranges.stdout',
    pinned: 'pnpm/outdated.stdout',
  },
  yarn: {
    ranges: 'yarn/v1-outdated-ranges.stdout',
    pinned: 'yarn/v1-outdated.stdout',
  },
  bun: { ranges: 'bun/outdated-ranges.stdout', pinned: 'bun/outdated.stdout' },
}

const mockOutdated = (
  pm: keyof typeof outdatedOutput,
  project: 'ranges' | 'pinned',
) => {
  mockedRunProcess.mockImplementation(async (_file, args) => {
    // pnpm's in-range versions come from a second, `--compatible` run.
    const fixture = args.includes('--compatible')
      ? `pnpm/outdated${project === 'ranges' ? '-ranges' : ''}-compatible.stdout`
      : outdatedOutput[pm][project]
    const stdout = readFixture(fixture)
    if (pm === 'bun') return { stdout, stderr: '' }
    // npm, pnpm and yarn exit 1 when anything is outdated.
    throw exitError(1, stdout, '')
  })
}

describe.each([
  ['npm', () => new NPMManager()],
  ['pnpm', () => new PNPMManager()],
  ['yarn', () => new YarnManager()],
  ['bun', () => new BunManager()],
] as const)('%s, default config', (pm, create) => {
  const proposals = async (project: 'ranges' | 'pinned') => {
    mockOutdated(pm, project)
    const outdated = await create().checkPackageVersions('/project')
    const results = await filterPackages(outdated, { cwd: '/project' })
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
