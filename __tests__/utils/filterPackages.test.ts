import type { AlwaysUpToDateConfig, PackageInfo } from '@/types'
import type filterPackagesType from '@/utils/filterPackages'
import type { splitUpdates as splitUpdatesType } from '@/utils/filterPackages'
import { withWarning } from '@/utils/filterPackages'
import type { RegistrySession } from '@/utils/registry'
import { wantedVersion } from '@/utils/wanted'
import { foldWorkspaceEntries } from '@/utils/workspaceRows'
import {
  type CapturedPackageOptions,
  capturedPackage,
  capturedRegistry,
  WORKSPACE_ENTRIES,
} from '../fixtures'

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
  /** Deprecated versions per package; given, the registry answers `lookup`. */
  deprecated?: Record<string, string[]>
  /** What the session looked up, as the plan's `lookedUp` reads it (#195). */
  lookedUp?: RegistrySession['lookedUp']
}

const DEFAULTS = {
  allowMinorUpdates: false,
  allowMajorUpdates: false,
  debug: false,
  silent: false,
  updateAllowlist: [],
  updateDenylist: [],
  cooldown: 0,
  depsDev: true,
  rules: {},
} as AlwaysUpToDateConfig

function loadFilterWithConfig(
  config: Partial<AlwaysUpToDateConfig>,
  opts: LoadOpts = {},
) {
  let filter: typeof filterPackagesType
  let split: typeof splitUpdatesType
  const releaseTimes = jest.fn(
    async (name: string) => opts.releaseTimes?.[name] ?? {},
  )
  jest.isolateModules(() => {
    jest.doMock('@/utils/logger', () => mockLogger)
    jest.doMock('@/utils/peers', () => ({
      readInstalledPeers: jest.fn(
        () => new Map(Object.entries(opts.installedPeers ?? {})),
      ),
    }))
    // biome-ignore lint/style/noCommonJs: jest.isolateModules requires synchronous require
    const loaded = require('@/utils/filterPackages')
    filter = loaded.default
    split = loaded.splitUpdates
  })
  const deprecatedLookup = async (name: string) => ({
    ok: true as const,
    package: {
      name,
      latest: '',
      source: 'packument' as const,
      versions: Object.keys(opts.releaseTimes?.[name] ?? {}).map((version) => ({
        version,
        deprecated: opts.deprecated?.[name]?.includes(version) ?? false,
      })),
    },
  })
  const run = (
    outdated: Record<string, PackageInfo>,
    options: Omit<
      Parameters<typeof filterPackagesType>[1],
      'config' | 'registry'
    > = {},
  ) =>
    filter!(outdated, {
      config: { ...DEFAULTS, ...config },
      registry: {
        releaseTimes,
        ...(opts.deprecated && {
          lookup: deprecatedLookup,
          lookedUp: deprecatedLookup,
        }),
        ...(opts.lookedUp && { lookedUp: opts.lookedUp }),
      },
      ...options,
    })
  return Object.assign(run, { split: split!, releaseTimes })
}

/** What a manifest declaring `name` at `range` gives the cooldown (the `declared` option). */
const declaring = (name: string, range: string) => () => ({
  name,
  spec: { range },
})

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

  describe('deprecated targets (#195)', () => {
    /** One outdated package as discovery reads it from its capture. */
    const outdatedFrom = (
      name: string,
      range: string,
      current: string,
      options: CapturedPackageOptions = {},
    ): Record<string, PackageInfo> => {
      const pkg = capturedPackage(name, options)
      return {
        [name]: {
          name,
          current,
          wanted: wantedVersion(range, pkg) ?? current,
          latest: pkg.latest,
        },
      }
    }
    const DEBUG_REDOS =
      'Debug versions >=3.2.0 <3.2.7 || >=4 <4.3.1 have a low-severity ReDos regression when used in a Node.js environment. It is recommended you upgrade to 3.2.7 or 4.3.1. (https://github.com/visionmedia/debug/issues/797)'
    const LODASH_BAD_RELEASE = 'Bad release. Please use lodash@4.17.21 instead.'
    // lodash 4.18.0 was `latest` for a day, until 4.18.1 replaced it.
    const LODASH_DAY = { asOf: '2026-04-01T00:00:00Z' }

    it('moves to a deprecated target from a deprecated installed version, with a warning', async () => {
      // Every debug 4.1.x is deprecated, so ~4.1.0 can only want 4.1.1, and
      // holding would keep 4.1.0, which carries the same deprecation.
      const outdated = outdatedFrom('debug', '~4.1.0', '4.1.0')
      expect(outdated.debug.wanted).toBe('4.1.1')
      const filter = loadFilterWithConfig(
        {},
        { lookedUp: capturedRegistry(['debug']).lookup },
      )

      const [result] = await filter(outdated)

      expect(result).toMatchObject({
        updated: true,
        target: '4.1.1',
        warning: `deprecated: ${DEBUG_REDOS}`,
      })
    })

    it('holds a deprecated latest that beyondRange would move to', async () => {
      const outdated = outdatedFrom('lodash', '4.17.21', '4.17.21', LODASH_DAY)
      expect(outdated.lodash.latest).toBe('4.18.0')
      const filter = loadFilterWithConfig(
        { beyondRange: 'minor' },
        { lookedUp: capturedRegistry(['lodash'], LODASH_DAY).lookup },
      )

      const [result] = await filter(outdated)

      expect(result).toMatchObject({
        updated: false,
        target: undefined,
        reason: `deprecated: ${LODASH_BAD_RELEASE}`,
      })
    })

    it('moves a deprecated target under a latest rule, with a warning', async () => {
      const filter = loadFilterWithConfig(
        { rules: { lodash: 'latest' } },
        { lookedUp: capturedRegistry(['lodash'], LODASH_DAY).lookup },
      )

      const [result] = await filter(
        outdatedFrom('lodash', '^4.17.21', '4.17.21', LODASH_DAY),
      )

      expect(result).toMatchObject({
        updated: true,
        target: '4.18.0',
        warning: `deprecated: ${LODASH_BAD_RELEASE}`,
      })
    })

    it('keeps a peer conflict warning beside the deprecation', async () => {
      const filter = loadFilterWithConfig(
        { rules: { lodash: 'latest' } },
        {
          lookedUp: capturedRegistry(['lodash'], LODASH_DAY).lookup,
          installedPeers: {
            lodash: [{ name: 'x', version: '1.0.0', range: '~4.17.0' }],
          },
        },
      )

      const [result] = await filter(
        outdatedFrom('lodash', '^4.17.21', '4.17.21', LODASH_DAY),
      )

      expect(result.warning).toBe(
        `peer conflict: x@1.0.0 needs lodash ~4.17.0; deprecated: ${LODASH_BAD_RELEASE}`,
      )
    })

    it('puts a message with line breaks and escape codes on one plain line', async () => {
      const filter = loadFilterWithConfig(
        {},
        {
          lookedUp: async (name) => ({
            ok: true,
            package: {
              name,
              latest: '1.0.1',
              source: 'packument',
              versions: [
                { version: '1.0.0', deprecated: false },
                {
                  version: '1.0.1',
                  deprecated: true,
                  deprecatedReason: 'use q\r\n\u001b[31minstead\u001b[0m ',
                },
              ],
            },
          }),
        },
      )

      const [result] = await filter(
        makeOutdated([
          { name: 'p', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
        ]),
      )

      expect(result.reason).toBe('deprecated: use q [31minstead [0m')
    })

    /** A lookup listing 1.0.0 and 1.0.1, each deprecated with the message given (undefined: not deprecated). */
    const twoVersions =
      (installed: string | undefined, target: string | undefined) =>
      async (name: string) => ({
        ok: true as const,
        package: {
          name,
          latest: '1.0.1',
          source: 'packument' as const,
          versions: [
            {
              version: '1.0.0',
              deprecated: installed !== undefined,
              ...(installed && { deprecatedReason: installed }),
            },
            {
              version: '1.0.1',
              deprecated: target !== undefined,
              ...(target && { deprecatedReason: target }),
            },
          ],
        },
      })
    const pMoving = makeOutdated([
      { name: 'p', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
    ])

    it('holds a target deprecated for another reason than the installed version', async () => {
      const filter = loadFilterWithConfig(
        {},
        { lookedUp: twoVersions('upgrade to 2.x', 'use bar instead') },
      )

      const [result] = await filter(pMoving)

      expect(result).toMatchObject({
        updated: false,
        reason: 'deprecated: use bar instead',
      })
    })

    it('drops bidirectional and zero-width characters and cuts a long message', async () => {
      const filter = loadFilterWithConfig(
        {},
        {
          lookedUp: twoVersions(
            undefined,
            `use \u202eq\u202c\u200b instead ${'x'.repeat(500)}`,
          ),
        },
      )

      const [result] = await filter(pMoving)

      expect(result.reason).toBe(
        `deprecated: ${`use q instead ${'x'.repeat(500)}`.slice(0, 400)}…`,
      )
    })

    it('says in a debug line when the session never looked the name up', async () => {
      const filter = loadFilterWithConfig({}, { lookedUp: () => undefined })

      const [result] = await filter(pMoving)

      expect(result).toMatchObject({ updated: true, target: '1.0.1' })
      expect(mockLogger.default.debug).toHaveBeenCalledWith(
        "No lookup of p in this session; its deprecation isn't checked",
      )
    })

    it('says so when the registry gives no message', async () => {
      const filter = loadFilterWithConfig(
        {},
        { deprecated: { p: ['1.0.1'] }, releaseTimes: { p: { '1.0.1': '' } } },
      )

      const [result] = await filter(
        makeOutdated([
          { name: 'p', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
        ]),
      )

      expect(result.reason).toBe('deprecated: no message given')
    })

    it('moves a target that is not deprecated, with no warning', async () => {
      const filter = loadFilterWithConfig(
        {},
        { lookedUp: capturedRegistry(['debug']).lookup },
      )

      const [result] = await filter(outdatedFrom('debug', '^4.1.0', '4.1.0'))

      expect(result).toMatchObject({ updated: true, target: '4.4.3' })
      expect(result.warning).toBeUndefined()
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

    it('asks for the versions between current and the target it judges', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 7 },
        { releaseTimes: { foo: { '1.0.1': daysAgo(10) } } },
      )

      await filter(
        makeOutdated([
          { name: 'foo', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
        ]),
        { now: NOW },
      )

      expect(filter.releaseTimes).toHaveBeenCalledTimes(1)
      expect(filter.releaseTimes).toHaveBeenCalledWith('foo', {
        current: '1.0.0',
        target: '1.0.1',
      })
    })

    it("asks for an alias's target under its own window", async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 7 },
        { releaseTimes: { target: { '1.0.1': daysAgo(10) } } },
      )

      await filter(
        makeOutdated([
          { name: 'key', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
        ]),
        {
          now: NOW,
          declared: declaring('target', '^1.0.0'),
        },
      )

      expect(filter.releaseTimes).toHaveBeenCalledWith('target', {
        current: '1.0.0',
        target: '1.0.1',
      })
    })

    it('never asks about a step whose cooldown is zero, and keeps no release age for it', async () => {
      const declared = jest.fn(({ name }: { name: string }) => ({
        name,
        spec: { range: '^1.0.0' },
      }))
      const filter = loadFilterWithConfig(
        { cooldown: { patch: 0, minor: 7 } },
        {
          releaseTimes: {
            patch: { '1.0.1': daysAgo(0) },
            minor: { '1.1.0': daysAgo(10) },
          },
        },
      )

      const results = await filter(
        makeOutdated([
          { name: 'patch', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
          { name: 'minor', current: '1.0.0', wanted: '1.1.0', latest: '1.1.0' },
        ]),
        { now: NOW, declared },
      )

      // Nor reads its manifest: the pipeline's `declared` reads package.json.
      expect(declared.mock.calls.map(([row]) => row.name)).toEqual(['minor'])
      expect(filter.releaseTimes).toHaveBeenCalledTimes(1)
      expect(filter.releaseTimes).toHaveBeenCalledWith('minor', {
        current: '1.0.0',
        target: '1.1.0',
      })
      expect(results.find((r) => r.name === 'patch')).toMatchObject({
        updated: true,
        target: '1.0.1',
        releaseAge: undefined,
      })
      expect(
        Math.round(results.find((r) => r.name === 'minor')?.releaseAge ?? 0),
      ).toBe(10)
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

    it('moves to the newest version past cooldown when the target is too fresh (#147)', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 2 },
        {
          releaseTimes: {
            foo: {
              '4.0.101': daysAgo(10),
              '4.0.102': daysAgo(3),
              '4.0.103': daysAgo(1),
            },
          },
        },
      )

      const results = await filter(
        makeOutdated([
          {
            name: 'foo',
            current: '4.0.101',
            wanted: '4.0.103',
            latest: '4.0.103',
          },
        ]),
        { now: NOW, declared: declaring('foo', '^4.0.101') },
      )

      expect(results[0]).toMatchObject({
        updated: true,
        target: '4.0.102',
        updateType: 'patch',
        reason: 'cooldown: 4.0.103 released 1d ago, requires 2d',
      })
      expect(Math.round(results[0].releaseAge ?? 0)).toBe(3)
      expect(filter.split(results)).toMatchObject({
        names: [],
        withinRange: [],
        pinned: [
          { path: '.', name: 'foo', version: '4.0.102', beyondRange: false },
        ],
      })
    })

    it('skips deprecated, pre-release and too-fresh versions for the fallback (#147)', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 2 },
        {
          releaseTimes: {
            foo: {
              '1.0.1': daysAgo(10),
              '1.0.2': daysAgo(1),
              '1.0.3-beta.1': daysAgo(20),
              '1.0.3': daysAgo(5),
              '1.0.4': daysAgo(1),
            },
          },
          deprecated: { foo: ['1.0.3'] },
        },
      )

      const [result] = await filter(
        makeOutdated([
          { name: 'foo', current: '1.0.0', wanted: '1.0.4', latest: '1.0.4' },
        ]),
        { now: NOW, declared: declaring('foo', '^1.0.0') },
      )

      expect(result).toMatchObject({ updated: true, target: '1.0.1' })
    })

    it('judges the fallback by its own step with a per-type cooldown (#147)', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: { minor: 7, patch: 1 } },
        {
          releaseTimes: {
            foo: {
              '1.0.5': daysAgo(2),
              '1.1.0': daysAgo(3),
              '1.2.0': daysAgo(3),
            },
          },
        },
      )

      const [result] = await filter(
        makeOutdated([
          { name: 'foo', current: '1.0.0', wanted: '1.2.0', latest: '1.2.0' },
        ]),
        { now: NOW, declared: declaring('foo', '^1.0.0') },
      )

      expect(result).toMatchObject({
        updated: true,
        target: '1.0.5',
        updateType: 'patch',
      })
    })

    it('falls back past the range, below latest, as a pinned beyond-range row (#147)', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 7, beyondRange: 'major' },
        {
          releaseTimes: {
            foo: { '2.0.0': daysAgo(30), '2.1.0': daysAgo(1) },
          },
        },
      )

      const results = await filter(
        makeOutdated([{ name: 'foo', current: '1.0.0', latest: '2.1.0' }]),
        { now: NOW },
      )

      expect(results[0]).toMatchObject({
        updated: true,
        target: '2.0.0',
        updateType: 'major',
      })
      expect(filter.split(results).pinned).toEqual([
        { path: '.', name: 'foo', version: '2.0.0', beyondRange: true },
      ])
    })

    it('falls back only to a version the declared range allows, below wanted (#151)', async () => {
      // `^0.7.1 || ^2.1.3` skips 1.x, 2.0.x and 2.1.0-2.1.2. Pinned to 2.1.2
      // and given its range back, the manager would install 2.1.3.
      const filter = loadFilterWithConfig(
        { cooldown: 2200 },
        {
          releaseTimes: {
            ms: {
              '0.7.2': daysAgo(3656),
              '0.7.3': daysAgo(3521),
              '1.0.0': daysAgo(3510),
              '2.0.0': daysAgo(3453),
              '2.1.2': daysAgo(2702),
              '2.1.3': daysAgo(2151),
            },
          },
        },
      )

      const results = await filter(
        makeOutdated([
          { name: 'ms', current: '0.7.1', wanted: '2.1.3', latest: '2.1.3' },
        ]),
        { now: NOW, declared: declaring('ms', '^0.7.1 || ^2.1.3') },
      )

      expect(results[0]).toMatchObject({
        updated: true,
        target: '0.7.3',
        updateType: 'patch',
        reason: 'cooldown: 2.1.3 released 2151d ago, requires 2200d',
      })
    })

    it('holds an in-range target when the declared range is unknown (#151)', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 2 },
        {
          releaseTimes: {
            foo: { '1.0.1': daysAgo(10), '1.0.2': daysAgo(1) },
          },
        },
      )

      const [result] = await filter(
        makeOutdated([
          { name: 'foo', current: '1.0.0', wanted: '1.0.2', latest: '1.0.2' },
        ]),
        { now: NOW, declared: () => undefined },
      )

      expect(result).toMatchObject({
        updated: false,
        target: undefined,
        reason: 'cooldown: released 1d ago, requires 2d',
      })
    })

    it('asks what the manifest declares for a row the cooldown checks, by its key and workspace (#151)', async () => {
      const declared = jest.fn(declaring('foo', '^1.0.0'))
      const filter = loadFilterWithConfig(
        { cooldown: 2 },
        {
          releaseTimes: {
            foo: { '1.0.1': daysAgo(10), '1.0.2': daysAgo(1) },
          },
        },
      )

      await filter(
        makeOutdated([
          { name: 'foo', current: '1.0.0', wanted: '1.0.2', latest: '1.0.2' },
          { name: 'bar', current: '1.0.0', wanted: '1.0.0', latest: '1.0.0' },
        ]),
        { now: NOW, declared },
      )

      expect(declared.mock.calls).toEqual([
        [{ name: 'foo', workspace: undefined }],
      ])
    })

    it("reads an npm: alias's release dates and deprecations from its target (#152)", async () => {
      // `"m": "npm:ms@^2.0.0"`: the registry's m is another package, whose
      // dates have no ms version.
      const filter = loadFilterWithConfig(
        { cooldown: 2200 },
        {
          releaseTimes: {
            ms: {
              '2.1.1': daysAgo(3254),
              '2.1.2': daysAgo(2702),
              '2.1.3': daysAgo(2151),
            },
            m: { '1.10.0': daysAgo(2600) },
          },
          deprecated: { ms: ['2.1.2'] },
        },
      )

      const [result] = await filter(
        makeOutdated([
          { name: 'm', current: '2.0.0', wanted: '2.1.3', latest: '2.1.3' },
        ]),
        {
          now: NOW,
          declared: () => ({ name: 'ms', spec: { range: '^2.0.0' } }),
        },
      )

      expect(result).toMatchObject({
        name: 'm',
        updated: true,
        target: '2.1.1',
        reason: 'cooldown: 2.1.3 released 2151d ago, requires 2200d',
      })
    })

    it('holds a version the registry gives no time for (#139)', async () => {
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

      expect(results[0]).toMatchObject({
        updated: false,
        target: undefined,
        reason: 'cooldown: release date unknown, requires 7d',
      })
    })
  })

  describe('workspace projects', () => {
    const NOW = Date.parse('2026-04-29T12:00:00Z')
    const daysAgo = (days: number) =>
      new Date(NOW - days * 24 * 60 * 60 * 1000).toISOString()
    const workspaceOutdated = () => foldWorkspaceEntries(WORKSPACE_ENTRIES)

    it('plans one result per package and manifest, workspace second in key order', async () => {
      const results = await loadFilterWithConfig({})(workspaceOutdated())

      expect(results.map((r) => [r.name, r.workspace])).toEqual([
        ['dayjs', '.'],
        ['dayjs', 'packages/b'],
        ['debug', 'packages/b'],
        ['ms', '.'],
        ['ms', 'packages/a'],
      ])
      expect(Object.keys(results[0]).slice(0, 2)).toEqual(['name', 'workspace'])
      expect(results.map((r) => r.updated)).toEqual([
        false,
        true,
        true,
        true,
        false,
      ])
      expect(results[0].reason).toBe('patch beyond the range')
      expect(results[4].reason).toBe('patch beyond the range')
    })

    it('leaves a workspace key off single-package results', async () => {
      const [result] = await loadFilterWithConfig({})(
        makeOutdated([
          { name: 'foo', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
        ]),
      )

      expect(Object.keys(result)).toEqual([
        'name',
        'current',
        'wanted',
        'latest',
        'target',
        'updateType',
        'updated',
        'reason',
      ])
    })

    it('holds every manifest of a package a hold rule names', async () => {
      const results = await loadFilterWithConfig({ rules: { dayjs: 'hold' } })(
        workspaceOutdated(),
      )

      expect(
        results.filter((r) => r.name === 'dayjs').map((r) => r.updated),
      ).toEqual([false, false])
    })

    const together = () =>
      foldWorkspaceEntries([
        {
          name: 'foo',
          workspace: '.',
          current: '1.10.0',
          wanted: '1.10.8',
          latest: '1.11.23',
        },
        {
          name: 'foo',
          workspace: 'packages/m',
          current: '1.0.0',
          wanted: '1.11.23',
          latest: '1.11.23',
        },
      ])

    it('re-checks peers once the together rule holds a package', async () => {
      // The root's P is held by Q's peer range, packages/m's P moves within
      // its own. The together rule then holds P everywhere, so P@1.0.0 stays
      // installed and its peer range on x must hold x's move as well.
      const filter = loadFilterWithConfig(
        {},
        {
          installedPeers: {
            P: [{ name: 'Q', version: '1.0.0', range: '<1.2.0' }],
            x: [{ name: 'P', version: '1.0.0', range: '1.0.x' }],
          },
        },
      )

      const results = await filter(
        foldWorkspaceEntries([
          {
            name: 'P',
            workspace: '.',
            current: '1.0.0',
            wanted: '1.2.0',
            latest: '1.2.0',
          },
          {
            name: 'P',
            workspace: 'packages/m',
            current: '1.0.0',
            wanted: '1.1.0',
            latest: '1.2.0',
          },
          {
            name: 'x',
            workspace: '.',
            current: '1.0.0',
            wanted: '1.5.0',
            latest: '1.5.0',
          },
        ]),
      )

      expect(
        results.map((r) => [r.name, r.workspace, r.updated, r.reason]),
      ).toEqual([
        ['P', '.', false, 'peer conflict: Q@1.0.0 needs P <1.2.0'],
        [
          'P',
          'packages/m',
          false,
          'held with the root (peer conflict: Q@1.0.0 needs P <1.2.0)',
        ],
        ['x', '.', false, 'peer conflict: P@1.0.0 needs x 1.0.x'],
      ])
    })

    it('holds the package in every manifest when one is held by the cooldown', async () => {
      // packages/m has no version past cooldown above its current to fall
      // back to, so it is held, and the root with it.
      const filter = loadFilterWithConfig(
        { cooldown: 7 },
        {
          releaseTimes: {
            foo: { '1.11.23': daysAgo(2), '1.10.8': daysAgo(60) },
          },
        },
      )

      const results = await filter(
        foldWorkspaceEntries([
          {
            name: 'foo',
            workspace: '.',
            current: '1.10.0',
            wanted: '1.10.8',
            latest: '1.11.23',
          },
          {
            name: 'foo',
            workspace: 'packages/m',
            current: '1.11.0',
            wanted: '1.11.23',
            latest: '1.11.23',
          },
        ]),
        { now: NOW },
      )

      expect(results.map((r) => r.updated)).toEqual([false, false])
      expect(results[0].reason).toMatch(/^held with packages\/m \(cooldown: /)
      expect(results[1].reason).toMatch(/^cooldown: /)
    })

    it('pins every row of a package when one falls back from the cooldown (#147)', async () => {
      // packages/m falls back to 1.10.8, the root's own wanted: both move,
      // and both are pinned, since the root's in-range command would move
      // packages/m's range to 1.11.23 as well.
      const filter = loadFilterWithConfig(
        { cooldown: 7 },
        {
          releaseTimes: {
            foo: { '1.11.23': daysAgo(2), '1.10.8': daysAgo(60) },
          },
        },
      )

      const results = await filter(together(), {
        now: NOW,
        declared: ({ workspace }) =>
          declaring('foo', workspace === '.' ? '~1.10.0' : '^1.0.0')(),
      })

      expect(results.map((r) => [r.updated, r.target])).toEqual([
        [true, '1.10.8'],
        [true, '1.10.8'],
      ])
      expect(filter.split(results)).toMatchObject({
        names: [],
        manifests: [],
        pinned: [
          { path: '.', name: 'foo', version: '1.10.8', beyondRange: false },
          {
            path: 'packages/m',
            name: 'foo',
            version: '1.10.8',
            beyondRange: false,
          },
        ],
      })
    })

    it('names the root as the blocker when the root row is the held one', async () => {
      const filter = loadFilterWithConfig(
        { cooldown: 7 },
        {
          releaseTimes: {
            foo: { '1.10.8': daysAgo(2), '1.11.23': daysAgo(60) },
          },
        },
      )

      const results = await filter(together(), { now: NOW })

      expect(results[1].reason).toMatch(/^held with the root \(cooldown: /)
    })

    it('does not let a held exact pin block the other manifests', async () => {
      const results = await loadFilterWithConfig({})(
        foldWorkspaceEntries([
          {
            name: 'foo',
            workspace: '.',
            current: '1.0.0',
            wanted: '1.0.0',
            latest: '1.0.5',
          },
          {
            name: 'foo',
            workspace: 'packages/m',
            current: '1.0.0',
            wanted: '1.0.3',
            latest: '1.0.5',
          },
        ]),
      )

      expect(results.map((r) => r.updated)).toEqual([false, true])
    })

    it('splits the plan per manifest, root first', async () => {
      const filter = loadFilterWithConfig({ beyondRange: 'patch' })
      const results = await filter(workspaceOutdated())

      const { names, withinRange, beyondRange, manifests } =
        filter.split(results)

      expect(names).toEqual(['dayjs', 'debug', 'ms'])
      expect(withinRange).toEqual(['dayjs', 'debug', 'ms'])
      expect(beyondRange).toEqual({ dayjs: '1.11.23', ms: '2.1.3' })
      expect(manifests).toEqual([
        {
          path: '.',
          withinRange: ['ms'],
          beyondRange: { dayjs: '1.11.23' },
        },
        {
          path: 'packages/a',
          withinRange: [],
          beyondRange: { ms: '2.1.3' },
        },
        {
          path: 'packages/b',
          withinRange: ['dayjs', 'debug'],
          beyondRange: {},
        },
      ])
    })

    // #127: yarn v1 moves a member's packages with root installs (the pin
    // path), so a package moving in a member is pinned in every manifest.
    describe('with pinMembers', () => {
      it("pins a member's moves and leaves the root's own to the manager", async () => {
        const filter = loadFilterWithConfig({})
        const results = await filter(workspaceOutdated())

        expect(filter.split(results, { pinMembers: true })).toEqual({
          names: ['ms'],
          withinRange: ['ms'],
          beyondRange: {},
          manifests: [{ path: '.', withinRange: ['ms'], beyondRange: {} }],
          pinned: [
            {
              path: 'packages/b',
              name: 'dayjs',
              version: '1.11.23',
              beyondRange: false,
            },
            {
              path: 'packages/b',
              name: 'debug',
              version: '4.3.7',
              beyondRange: false,
            },
          ],
        })
      })

      it("pins the root's row of a package that also moves in a member", async () => {
        const filter = loadFilterWithConfig({ beyondRange: 'patch' })
        const results = await filter(workspaceOutdated())

        const { names, manifests, pinned } = filter.split(results, {
          pinMembers: true,
        })

        expect(names).toEqual([])
        expect(manifests).toEqual([])
        expect(pinned).toEqual([
          { path: '.', name: 'dayjs', version: '1.11.23', beyondRange: true },
          {
            path: 'packages/b',
            name: 'dayjs',
            version: '1.11.23',
            beyondRange: false,
          },
          {
            path: 'packages/b',
            name: 'debug',
            version: '4.3.7',
            beyondRange: false,
          },
          { path: '.', name: 'ms', version: '2.1.3', beyondRange: false },
          {
            path: 'packages/a',
            name: 'ms',
            version: '2.1.3',
            beyondRange: true,
          },
        ])
      })
    })

    it('gives a single-package project the root as its only manifest', async () => {
      const filter = loadFilterWithConfig({})
      const results = await filter(
        makeOutdated([
          { name: 'foo', current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
        ]),
      )

      const { withinRange, beyondRange, manifests } = filter.split(results)

      expect(manifests).toEqual([{ path: '.', withinRange, beyondRange }])
    })
  })
})

describe('withWarning', () => {
  const row = {
    name: 'p',
    current: '1.0.0',
    wanted: '1.0.1',
    latest: '1.0.1',
    target: '1.0.1',
    updateType: 'patch' as const,
    updated: true,
  }

  it('adds a message holding "; " once, however often it is added (#195)', () => {
    const message = 'deprecated: use q; see the changelog'
    const once = withWarning(row, message)

    expect(withWarning(withWarning(once, 'peer conflict: x'), message)).toEqual(
      { ...row, warning: `${message}; peer conflict: x` },
    )
  })
})
