import type { AlwaysUpToDateConfig, PackageInfo } from '@/types'
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
  installedPeers?: Record<
    string,
    Array<{ name: string; version: string; range: string }>
  >
}

const DEFAULTS = {
  allowMinorUpdates: false,
  allowMajorUpdates: false,
  debug: false,
  silent: false,
  updateAllowlist: [],
  updateDenylist: [],
  cooldown: 0,
  rules: {},
} as AlwaysUpToDateConfig

function loadFilterWithConfig(
  config: Partial<AlwaysUpToDateConfig>,
  opts: LoadOpts = {},
) {
  let filter: typeof filterPackagesType
  jest.isolateModules(() => {
    jest.doMock('@/utils/logger', () => mockLogger)
    jest.doMock('@/utils/npmrcLoader', () => ({
      loadRegistryConfig: () => ({
        registry: 'https://registry.npmjs.org/',
        scopedRegistries: {},
        authTokens: {},
      }),
    }))
    jest.doMock('@/utils/peers', () => ({
      readInstalledPeers: jest.fn(
        () => new Map(Object.entries(opts.installedPeers ?? {})),
      ),
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
  return (
    outdated: Record<string, PackageInfo>,
    options: Omit<Parameters<typeof filterPackagesType>[1], 'config'> = {},
  ) => filter!(outdated, { config: { ...DEFAULTS, ...config }, ...options })
}

const makeOutdated = (
  packages: Array<{
    name: string
    current: string
    wanted?: string
    latest: string
  }>,
): Record<string, PackageInfo> => {
  const result: Record<string, PackageInfo> = {}
  for (const pkg of packages) {
    // Without a wanted version the range is treated as an exact pin.
    result[pkg.name] = { ...pkg, wanted: pkg.wanted ?? pkg.current }
  }
  return result
}

describe('filterPackages', () => {
  it('returns update results for all packages', async () => {
    const filter = loadFilterWithConfig({})
    const outdated = makeOutdated([
      { name: 'foo', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
      { name: 'bar', current: '1.0.0', wanted: '1.0.0', latest: '2.0.0' },
    ])

    const results = await filter(outdated)

    expect(results).toHaveLength(2)
    expect(results[0].name).toBe('foo')
    expect(results[0].updated).toBe(true)
    expect(results[0].updateType).toBe('patch')
    expect(results[1].name).toBe('bar')
    expect(results[1].updated).toBe(false)
    expect(results[1].updateType).toBe('major')
    expect(results[1].reason).toBe('major beyond the range')
  })

  it('reports the in-range target and wanted version', async () => {
    const filter = loadFilterWithConfig({})
    const outdated = makeOutdated([
      { name: 'react', current: '18.2.0', wanted: '18.3.1', latest: '19.3.1' },
    ])

    const [result] = await filter(outdated)

    expect(result).toMatchObject({
      wanted: '18.3.1',
      target: '18.3.1',
      updated: true,
      updateType: 'minor',
    })
  })

  it('marks targeted packages as eligible and others as not targeted', async () => {
    const filter = loadFilterWithConfig({})
    const outdated = makeOutdated([
      { name: 'foo', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
      { name: 'bar', current: '1.0.0', wanted: '1.0.2', latest: '1.0.2' },
      { name: 'baz', current: '1.0.0', wanted: '1.0.3', latest: '1.0.3' },
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
      { name: 'foo', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
      { name: 'bar', current: '1.0.0', wanted: '1.0.2', latest: '1.0.2' },
    ])

    const results = await filter(outdated, { targetPackages: ['foo', 'bar'] })

    expect(results.find((r) => r.name === 'foo')?.updated).toBe(false)
    expect(results.find((r) => r.name === 'foo')?.reason).toBe('held by rule')
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
      { name: 'foo', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
    ])

    const withEmpty = await filter(outdated, { targetPackages: [] })
    const withUndefined = await filter(outdated)

    // Empty array passes the length > 0 check, so behaves like no targeting
    expect(withEmpty[0].updated).toBe(true)
    expect(withUndefined[0].updated).toBe(true)
  })

  it('holds a target an override does not allow, even with a latest rule', async () => {
    const filter = loadFilterWithConfig({ rules: { dayjs: 'latest' } })
    const outdated = makeOutdated([
      { name: 'dayjs', current: '1.11.9', latest: '1.11.23' },
      { name: 'ms', current: '2.1.2', wanted: '2.1.3', latest: '2.1.3' },
    ])

    const results = await filter(outdated, {
      overrides: {
        dayjs: { field: 'resolutions', range: '1.11.9' },
      },
    })

    expect(results.find((r) => r.name === 'dayjs')).toMatchObject({
      updated: false,
      reason: 'controlled by resolutions (1.11.9)',
    })
    expect(results.find((r) => r.name === 'ms')?.updated).toBe(true)
  })

  it('names the override when it is what keeps a package in place', async () => {
    // pnpm reports the overridden version as current and wanted.
    const filter = loadFilterWithConfig({})
    const outdated = makeOutdated([
      { name: 'dayjs', current: '1.11.9', latest: '1.11.23' },
    ])

    const [result] = await filter(outdated, {
      overrides: {
        dayjs: { field: 'overrides in pnpm-workspace.yaml', range: '1.11.9' },
      },
    })

    expect(result).toMatchObject({
      updated: false,
      reason: 'controlled by overrides in pnpm-workspace.yaml (1.11.9)',
    })
  })

  it('lets a target through when the override allows it', async () => {
    // npm requires a direct dependency's override to equal its own spec, so
    // an in-range update satisfies it; npm update installs it.
    const filter = loadFilterWithConfig({})
    const outdated = makeOutdated([
      {
        name: 'dayjs',
        current: '1.11.9',
        wanted: '1.11.23',
        latest: '1.11.23',
      },
    ])

    const [result] = await filter(outdated, {
      overrides: {
        dayjs: { field: 'overrides', range: '^1.11.9' },
      },
    })

    expect(result).toMatchObject({ updated: true, target: '1.11.23' })
  })

  it('holds a beyond-range target outside an override that equals the spec', async () => {
    const filter = loadFilterWithConfig({ beyondRange: 'major' })
    const outdated = makeOutdated([
      { name: 'react', current: '18.2.0', wanted: '18.3.1', latest: '19.3.1' },
    ])

    const [result] = await filter(outdated, {
      overrides: {
        react: { field: 'overrides', range: '^18.2.0' },
      },
    })

    expect(result).toMatchObject({
      updated: false,
      reason: 'controlled by overrides (^18.2.0)',
    })
  })

  describe('installed peer ranges', () => {
    // On the benchmark project: react-query 4 and next 14 accept react 18 only.
    const peersOnReact = {
      react: [
        {
          name: '@tanstack/react-query',
          version: '4.29.5',
          range: '^16.8.0 || ^17.0.0 || ^18.0.0',
        },
        { name: 'react-dom', version: '18.2.0', range: '^18.2.0' },
      ],
      'react-dom': [
        {
          name: '@tanstack/react-query',
          version: '4.29.5',
          range: '^16.8.0 || ^17.0.0 || ^18.0.0',
        },
      ],
    }
    const reactPair = makeOutdated([
      { name: 'react', current: '18.2.0', wanted: '18.3.1', latest: '19.3.1' },
      {
        name: 'react-dom',
        current: '18.2.0',
        wanted: '18.3.1',
        latest: '19.3.1',
      },
    ])

    it('holds a target an installed peer range excludes, naming the package', async () => {
      const filter = loadFilterWithConfig(
        { beyondRange: 'major' },
        { installedPeers: peersOnReact },
      )

      const results = await filter(reactPair)

      expect(results.find((r) => r.name === 'react')).toMatchObject({
        updated: false,
        reason:
          'peer conflict: @tanstack/react-query@4.29.5 needs react ^16.8.0 || ^17.0.0 || ^18.0.0',
      })
    })

    it('ignores the peer ranges of packages moving in the same run', async () => {
      const filter = loadFilterWithConfig(
        { beyondRange: 'major' },
        { installedPeers: { react: [peersOnReact.react[1]] } },
      )

      const results = await filter(reactPair)

      // react-dom 18.2.0 needs react ^18.2.0, but react-dom moves to 19 too.
      expect(results.find((r) => r.name === 'react')).toMatchObject({
        updated: true,
        target: '19.3.1',
      })
    })

    it('holds packages whose co-update was held, until nothing changes', async () => {
      // react-dom is held by react-query's peer range; react-dom 18.2.0
      // then stays, and its own peer range blocks react 19.
      const filter = loadFilterWithConfig(
        { beyondRange: 'major' },
        {
          installedPeers: {
            react: [peersOnReact.react[1]],
            'react-dom': peersOnReact['react-dom'],
          },
        },
      )

      const results = await filter(reactPair)

      expect(results.find((r) => r.name === 'react-dom')?.updated).toBe(false)
      expect(results.find((r) => r.name === 'react')).toMatchObject({
        updated: false,
        reason: 'peer conflict: react-dom@18.2.0 needs react ^18.2.0',
      })
    })

    it('keeps an in-range target the installed peers accept', async () => {
      const filter = loadFilterWithConfig({}, { installedPeers: peersOnReact })

      const results = await filter(reactPair)

      expect(results.map((r) => r.target)).toEqual(['18.3.1', '18.3.1'])
    })

    it('lets a latest rule through with a warning', async () => {
      const filter = loadFilterWithConfig(
        { rules: { react: 'latest' } },
        { installedPeers: peersOnReact },
      )

      const results = await filter(makeOutdated([reactPair.react]))

      expect(results[0]).toMatchObject({
        updated: true,
        target: '19.3.1',
        warning:
          'peer conflict: @tanstack/react-query@4.29.5 needs react ^16.8.0 || ^17.0.0 || ^18.0.0',
      })
    })
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
        makeOutdated([
          { name: 'foo', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
        ]),
        { now: NOW },
      )

      expect(results[0].updated).toBe(false)
      expect(results[0].reason).toMatch(/cooldown/)
      expect(Math.round(results[0].releaseAge ?? 0)).toBe(2)
    })

    it('judges the version it would move to, not latest', async () => {
      // In range: 18.3.1 is old; 19.3.1 (out of range) was published today.
      const filter = loadFilterWithConfig(
        { cooldown: 7 },
        {
          releaseTimes: {
            react: { '18.3.1': daysAgo(30), '19.3.1': daysAgo(0) },
          },
        },
      )

      const [result] = await filter(
        makeOutdated([
          {
            name: 'react',
            current: '18.2.0',
            wanted: '18.3.1',
            latest: '19.3.1',
          },
        ]),
        { now: NOW },
      )

      expect(result).toMatchObject({ updated: true, target: '18.3.1' })
      expect(Math.round(result.releaseAge ?? 0)).toBe(30)
    })

    it('lets a package through once cooldown has elapsed', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 7 },
        {
          releaseTimes: { foo: { '1.0.1': daysAgo(10) } },
        },
      )

      const results = await filter(
        makeOutdated([
          { name: 'foo', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
        ]),
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
        makeOutdated([
          { name: 'foo', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
        ]),
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

      // The policy already holds it, so the cooldown reason shouldn't apply.
      expect(results[0].updated).toBe(false)
      expect(results[0].reason).toBe('major beyond the range')
    })

    it('fails open when registry returns no time for the version', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 7 },
        { releaseTimes: { foo: {} } },
      )

      const results = await filter(
        makeOutdated([
          { name: 'foo', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
        ]),
        { now: NOW },
      )

      expect(results[0].updated).toBe(true)
    })
  })
})
