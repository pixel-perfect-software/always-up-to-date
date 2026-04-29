import type { PackageInfo } from '@/types'
import type filterPackagesType from '@/utils/filterPackages'

const mockLogger = {
  __esModule: true,
  default: {
    error: jest.fn(),
    skippingPackage: jest.fn(),
    debug: jest.fn(),
  },
}

interface LoadOpts {
  releaseTimes?: Record<string, Record<string, string>>
}

function loadFilterWithConfig(
  config: Record<string, unknown>,
  opts: LoadOpts = {},
) {
  let filter: typeof filterPackagesType
  jest.isolateModules(() => {
    jest.doMock('@/utils/config', () => ({
      loadConfig: () => ({
        allowMinorUpdates: false,
        allowMajorUpdates: false,
        debug: false,
        silent: false,
        updateAllowlist: [],
        updateDenylist: [],
        cooldown: 0,
        ...config,
      }),
    }))
    jest.doMock('@/utils/logger', () => mockLogger)
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
    // biome-ignore lint/style/noCommonJs: jest.isolateModules requires synchronous require
    filter = require('@/utils/filterPackages').default
  })
  return filter!
}

const makeOutdated = (
  packages: Array<{ name: string; current: string; latest: string }>,
): Record<string, PackageInfo> => {
  const result: Record<string, PackageInfo> = {}
  for (const pkg of packages) {
    result[pkg.name] = pkg
  }
  return result
}

describe('filterPackages', () => {
  it('returns update results for all packages', async () => {
    const filter = loadFilterWithConfig({})
    const outdated = makeOutdated([
      { name: 'foo', current: '1.0.0', latest: '1.0.1' },
      { name: 'bar', current: '1.0.0', latest: '2.0.0' },
    ])

    const results = await filter(outdated)

    expect(results).toHaveLength(2)
    expect(results[0].name).toBe('foo')
    expect(results[0].updated).toBe(true)
    expect(results[0].updateType).toBe('patch')
    expect(results[1].name).toBe('bar')
    expect(results[1].updated).toBe(false)
    expect(results[1].updateType).toBe('major')
  })

  it('marks targeted packages as eligible and others as not targeted', async () => {
    const filter = loadFilterWithConfig({})
    const outdated = makeOutdated([
      { name: 'foo', current: '1.0.0', latest: '1.0.1' },
      { name: 'bar', current: '1.0.0', latest: '1.0.2' },
      { name: 'baz', current: '1.0.0', latest: '1.0.3' },
    ])

    const results = await filter(outdated, { targetPackages: ['foo', 'baz'] })

    expect(results.find((r) => r.name === 'foo')?.updated).toBe(true)
    expect(results.find((r) => r.name === 'bar')?.updated).toBe(false)
    expect(results.find((r) => r.name === 'bar')?.reason).toBe('not targeted')
    expect(results.find((r) => r.name === 'baz')?.updated).toBe(true)
  })

  it('respects config when targeting packages', async () => {
    const filter = loadFilterWithConfig({ updateDenylist: ['foo'] })
    const outdated = makeOutdated([
      { name: 'foo', current: '1.0.0', latest: '1.0.1' },
      { name: 'bar', current: '1.0.0', latest: '1.0.2' },
    ])

    const results = await filter(outdated, { targetPackages: ['foo', 'bar'] })

    expect(results.find((r) => r.name === 'foo')?.updated).toBe(false)
    expect(results.find((r) => r.name === 'foo')?.reason).toBe(
      'skipped by config',
    )
    expect(results.find((r) => r.name === 'bar')?.updated).toBe(true)
  })

  it('includes updateType for all results', async () => {
    const filter = loadFilterWithConfig({ allowMajorUpdates: true })
    const outdated = makeOutdated([
      { name: 'patch-pkg', current: '1.0.0', latest: '1.0.1' },
      { name: 'minor-pkg', current: '1.0.0', latest: '1.1.0' },
      { name: 'major-pkg', current: '1.0.0', latest: '2.0.0' },
    ])

    const results = await filter(outdated)

    expect(results.find((r) => r.name === 'patch-pkg')?.updateType).toBe(
      'patch',
    )
    expect(results.find((r) => r.name === 'minor-pkg')?.updateType).toBe(
      'minor',
    )
    expect(results.find((r) => r.name === 'major-pkg')?.updateType).toBe(
      'major',
    )
  })

  it('returns empty array for empty input', async () => {
    const filter = loadFilterWithConfig({})
    const results = await filter({})
    expect(results).toEqual([])
  })

  it('handles empty target packages array same as no targeting', async () => {
    const filter = loadFilterWithConfig({})
    const outdated = makeOutdated([
      { name: 'foo', current: '1.0.0', latest: '1.0.1' },
    ])

    const withEmpty = await filter(outdated, { targetPackages: [] })
    const withUndefined = await filter(outdated)

    // Empty array passes the length > 0 check, so behaves like no targeting
    expect(withEmpty[0].updated).toBe(true)
    expect(withUndefined[0].updated).toBe(true)
  })

  describe('cooldown', () => {
    const NOW = Date.parse('2026-04-29T12:00:00Z')
    const daysAgo = (days: number) =>
      new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString()

    it('gates a package whose latest was published within the cooldown', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 7 },
        {
          releaseTimes: { foo: { '1.0.1': daysAgo(2) } },
        },
      )

      const results = await filter(
        makeOutdated([{ name: 'foo', current: '1.0.0', latest: '1.0.1' }]),
        { now: NOW },
      )

      expect(results[0].updated).toBe(false)
      expect(results[0].reason).toMatch(/cooldown/)
      expect(Math.round(results[0].releaseAge ?? 0)).toBe(2)
    })

    it('lets a package through once cooldown has elapsed', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 7 },
        {
          releaseTimes: { foo: { '1.0.1': daysAgo(10) } },
        },
      )

      const results = await filter(
        makeOutdated([{ name: 'foo', current: '1.0.0', latest: '1.0.1' }]),
        { now: NOW },
      )

      expect(results[0].updated).toBe(true)
      expect(Math.round(results[0].releaseAge ?? 0)).toBe(10)
    })

    it('honors per-update-type cooldown windows', async () => {
      const filter = loadFilterWithConfig(
        {
          allowMajorUpdates: true,
          cooldown: { patch: 0, minor: 7, major: 30 },
        },
        {
          releaseTimes: {
            patch: { '1.0.1': daysAgo(1) },
            minor: { '1.1.0': daysAgo(10) },
            major: { '2.0.0': daysAgo(10) },
          },
        },
      )

      const results = await filter(
        makeOutdated([
          { name: 'patch', current: '1.0.0', latest: '1.0.1' },
          { name: 'minor', current: '1.0.0', latest: '1.1.0' },
          { name: 'major', current: '1.0.0', latest: '2.0.0' },
        ]),
        { now: NOW },
      )

      expect(results.find((r) => r.name === 'patch')?.updated).toBe(true)
      expect(results.find((r) => r.name === 'minor')?.updated).toBe(true)
      expect(results.find((r) => r.name === 'major')?.updated).toBe(false)
    })

    it('skips network calls entirely when cooldown is zero', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 0 },
        { releaseTimes: { foo: { '1.0.1': daysAgo(0) } } },
      )

      const results = await filter(
        makeOutdated([{ name: 'foo', current: '1.0.0', latest: '1.0.1' }]),
      )

      expect(results[0].updated).toBe(true)
      expect(results[0].releaseAge).toBeUndefined()
    })

    it('does not gate a package that semver already rejected', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 7 },
        { releaseTimes: { foo: { '2.0.0': daysAgo(2) } } },
      )

      const results = await filter(
        makeOutdated([{ name: 'foo', current: '1.0.0', latest: '2.0.0' }]),
        { now: NOW },
      )

      // Major update is blocked by config, so cooldown reason shouldn't apply.
      expect(results[0].updated).toBe(false)
      expect(results[0].reason).toBe('skipped by config')
    })

    it('fails open when registry returns no time for the version', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 7 },
        { releaseTimes: { foo: {} } },
      )

      const results = await filter(
        makeOutdated([{ name: 'foo', current: '1.0.0', latest: '1.0.1' }]),
        { now: NOW },
      )

      expect(results[0].updated).toBe(true)
    })
  })
})
