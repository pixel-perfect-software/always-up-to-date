import type { CooldownConfig, PackageInfo } from '@/types'
import type { computeReleaseAges as computeReleaseAgesType } from '@/utils/releaseAges'

const NOW = Date.parse('2026-04-29T12:00:00Z')
const isoDaysAgo = (days: number) =>
  new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString()

interface LoadOpts {
  releaseTimes?: Record<string, Record<string, string>>
}

function loadComputeReleaseAges(opts: LoadOpts = {}) {
  let fn: typeof computeReleaseAgesType
  jest.isolateModules(() => {
    jest.doMock('@/utils/npmrcLoader', () => ({
      loadRegistryConfig: () => ({
        registry: 'https://registry.npmjs.org/',
        scopedRegistries: {},
        authTokens: {},
      }),
    }))
    jest.doMock('@/utils/registry', () => ({
      fetchReleaseTimes: jest.fn(
        async (name: string) => opts.releaseTimes?.[name] ?? {},
      ),
      clearRegistryCache: jest.fn(),
    }))
    // biome-ignore lint/style/noCommonJs: jest.isolateModules requires sync require
    fn = require('@/utils/releaseAges').computeReleaseAges
  })
  return (packages: Record<string, PackageInfo>, cooldown: CooldownConfig) =>
    fn!(packages, '/proj', cooldown, NOW)
}

const outdated = (pkgs: PackageInfo[]): Record<string, PackageInfo> =>
  Object.fromEntries(pkgs.map((p) => [p.name, p]))

const COOLDOWN = '7 days'

describe('computeReleaseAges', () => {
  it('returns an empty map when cooldown is disabled', async () => {
    const compute = loadComputeReleaseAges({
      releaseTimes: { foo: { '1.0.1': isoDaysAgo(5) } },
    })

    const ages = await compute(
      outdated([
        { name: 'foo', current: '1.0.0', wanted: '1.0.0', latest: '1.0.1' },
      ]),
      0,
    )

    expect(ages).toEqual({})
  })

  it('computes ages for each package when cooldown is enabled', async () => {
    const compute = loadComputeReleaseAges({
      releaseTimes: {
        foo: { '1.0.1': isoDaysAgo(2) },
        bar: { '2.0.0': isoDaysAgo(30) },
      },
    })

    const ages = await compute(
      outdated([
        { name: 'foo', current: '1.0.0', wanted: '1.0.0', latest: '1.0.1' },
        { name: 'bar', current: '1.0.0', wanted: '1.0.0', latest: '2.0.0' },
      ]),
      COOLDOWN,
    )

    expect(Math.round(ages.foo)).toBe(2)
    expect(Math.round(ages.bar)).toBe(30)
  })

  it('omits packages whose latest version has no published timestamp', async () => {
    const compute = loadComputeReleaseAges({
      releaseTimes: { foo: {} },
    })

    const ages = await compute(
      outdated([
        { name: 'foo', current: '1.0.0', wanted: '1.0.0', latest: '1.0.1' },
      ]),
      COOLDOWN,
    )

    expect(ages.foo).toBeUndefined()
  })

  it('skips entries with unparseable timestamps', async () => {
    const compute = loadComputeReleaseAges({
      releaseTimes: { foo: { '1.0.1': 'not-a-date' } },
    })

    const ages = await compute(
      outdated([
        { name: 'foo', current: '1.0.0', wanted: '1.0.0', latest: '1.0.1' },
      ]),
      COOLDOWN,
    )

    expect(ages.foo).toBeUndefined()
  })
})
