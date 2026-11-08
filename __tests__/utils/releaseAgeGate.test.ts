import type { PackageLookup, ReleaseAgeGate, ReleaseWindow } from '@/types'
import {
  exemptionOf,
  gateMinutesFor,
  gatePackage,
  isExempt,
  withReleaseAgeGate,
} from '@/utils/releaseAgeGate'
import { capturedPackage } from '../fixtures'

// yarn berry 4.18.1's npmMinimalAgeGate (#166), probed 2026-11-03 with
// `yarn install` against a local registry. The packages are registry captures; ms
// 2.1.3 was published 2020-12-08T13:54:35Z, 2.1.2 2019-06-06T17:31:55Z.
const MS_2_1_3 = Date.parse('2020-12-08T13:54:35Z')
const gate = (overrides: Partial<ReleaseAgeGate> = {}): ReleaseAgeGate => ({
  setting: 'npmMinimalAgeGate',
  minutes: 1440,
  scopes: {},
  exempt: [],
  missingTime: 'held',
  ...overrides,
})
const versionsOf = (pkg: { versions: { version: string }[] } | undefined) =>
  pkg?.versions.map((v) => v.version)

describe('gateMinutesFor', () => {
  it("takes a configured scope's own minutes, else the top level's", () => {
    const g = gate({ minutes: 0, scopes: { '@acme': 1440 } })
    expect(gateMinutesFor('@acme/probe', g)).toBe(1440)
    expect(gateMinutesFor('@other/probe', g)).toBe(0)
    expect(gateMinutesFor('probe', g)).toBe(0)
  })
})

describe('isExempt', () => {
  // Each manager's own syntax (#166, #168): berry and npm globs keep `*` in a
  // segment, pnpm's cross it, bun takes exact names.
  it.each([
    ['p-exempt', 'segment', 'p-exempt', '1.0.1', true],
    ['p-exempt', 'segment', 'p-other', '1.0.1', false],
    ['@acme/*@^1.0.0', 'segment', '@acme/probe', '1.0.1', true],
    ['@acme/*@^1.0.0', 'segment', '@acme/probe', '2.0.0', false],
    ['@acme/*', 'segment', '@acme/deep/name', '1.0.0', false],
    ['@acme/**', 'segment', '@acme/deep/name', '1.0.0', true],
    ['@acme*', 'any', '@acme/probe', '1.0.0', true],
    ['@acme*', 'segment', '@acme/probe', '1.0.0', false],
    ['p-?', 'segment', 'p-x', '1.0.0', true],
    ['p-fresh@1.0.1 || 1.0.2', 'any', 'p-fresh', '1.0.2', true],
    ['p-fresh@1.0.1', 'none', 'p-fresh', '1.0.2', false],
    ['p-*', 'none', 'p-fresh', '1.0.0', false],
    ['ms@not a range', 'segment', 'ms', '1.0.0', false],
  ] as const)(
    '%s (%s) exempts %s@%s: %s',
    (pattern, glob, name, version, expected) => {
      expect(isExempt(name, version, [exemptionOf(pattern, glob)])).toBe(
        expected,
      )
    },
  )

  it("keeps npm's `name@version` whole, so it matches no package (n06)", () => {
    expect(
      isExempt('p-fresh', '1.0.2', [
        { name: 'p-fresh@1.0.2', glob: 'segment' },
      ]),
    ).toBe(false)
  })
})

describe('gatePackage', () => {
  const ms = () => capturedPackage('ms')

  it('drops versions younger than the gate, and moves latest to the newest that passes', () => {
    const gated = gatePackage(ms(), gate(), {}, MS_2_1_3 + 60 * 60_000)
    expect(gated?.latest).toBe('2.1.2')
    expect(versionsOf(gated)).toContain('2.1.2')
    expect(versionsOf(gated)).not.toContain('2.1.3')
  })

  it('keeps latest once it is past the gate, and returns the package unchanged at 0', () => {
    const later = MS_2_1_3 + 1441 * 60_000
    expect(gatePackage(ms(), gate(), {}, later)?.latest).toBe('2.1.3')
    const pkg = ms()
    expect(gatePackage(pkg, gate({ minutes: 0 }), {}, MS_2_1_3)).toBe(pkg)
  })

  it('lets an exempt version through, and none with no known time (p-notime)', () => {
    const pkg = capturedPackage('ms', { source: 'packument' })
    const now = MS_2_1_3 + 60 * 60_000
    expect(gatePackage(pkg, gate(), {}, now)).toBeUndefined()
    expect(
      versionsOf(
        gatePackage(
          pkg,
          gate({ exempt: [exemptionOf('ms@2.1.3', 'segment')] }),
          {},
          now,
        ),
      ),
    ).toEqual(['2.1.3'])
    expect(
      gatePackage(
        pkg,
        gate(),
        { '2.1.2': '2019-06-06T17:31:55Z', '2.1.3': '2020-12-08T13:54:35Z' },
        now,
      )?.latest,
    ).toBe('2.1.2')
  })
})

describe('gatePackage for pnpm, bun and npm (#168)', () => {
  const now = MS_2_1_3 + 60 * 60_000

  it('lets a version with no publish time through where the manager does (p08, b07, n08)', () => {
    const pkg = capturedPackage('ms', { source: 'packument' })
    expect(
      gatePackage(pkg, gate({ missingTime: 'allowed' }), {}, now)?.latest,
    ).toBe('2.1.3')
  })

  it("holds what npm's `before` cuts off, even with no age (n10)", () => {
    const gated = gatePackage(
      capturedPackage('ms'),
      gate({
        minutes: 0,
        missingTime: 'allowed',
        notAfter: '2020-01-01T00:00:00.000Z',
      }),
      {},
      now,
    )
    expect(gated?.latest).toBe('2.1.2')
    expect(versionsOf(gated)).not.toContain('2.1.3')
  })
})

describe('withReleaseAgeGate', () => {
  const now = () => MS_2_1_3 + 60 * 60_000
  const session = (lookup: PackageLookup, times: Record<string, string>) => {
    const calls: string[] = []
    const windows: Array<ReleaseWindow | undefined> = []
    return {
      calls,
      windows,
      lookup: async (_name: string) => lookup,
      releaseTimes: async (name: string, window?: ReleaseWindow) => {
        calls.push(name)
        windows.push(window)
        return times
      },
    }
  }

  it('gates a lookup with the deps.dev times it carries, asking no packument', async () => {
    const base = session({ ok: true, package: capturedPackage('ms') }, {})
    const gated = withReleaseAgeGate(base, () => gate(), now)

    const result = await gated.lookup('ms')

    expect(result.ok && result.package.latest).toBe('2.1.2')
    expect(base.calls).toEqual([])
  })

  it('answers lookedUp with the gated lookup, once it was made (#195)', async () => {
    const base = session({ ok: true, package: capturedPackage('ms') }, {})
    const gated = withReleaseAgeGate(base, () => gate(), now)

    expect(gated.lookedUp('ms')).toBeUndefined()
    const looked = await gated.lookup('ms')

    expect(await gated.lookedUp('ms')).toBe(looked)
    expect(looked.ok && looked.package.latest).toBe('2.1.2')
  })

  it('fills times a packument lacks from the full packument', async () => {
    const base = session(
      { ok: true, package: capturedPackage('ms', { source: 'packument' }) },
      { '2.1.2': '2019-06-06T17:31:55Z', '2.1.3': '2020-12-08T13:54:35Z' },
    )
    const result = await withReleaseAgeGate(base, () => gate(), now).lookup(
      'ms',
    )
    expect(result.ok && result.package.latest).toBe('2.1.2')
    expect(base.calls).toEqual(['ms'])
  })

  it("forwards a cooldown's window to the session, and asks about every version for its own lookup", async () => {
    const base = session(
      { ok: true, package: capturedPackage('ms', { source: 'packument' }) },
      { '2.1.2': '2019-06-06T17:31:55Z', '2.1.3': '2020-12-08T13:54:35Z' },
    )
    const gated = withReleaseAgeGate(base, () => gate(), now)

    await gated.lookup('ms')
    await gated.releaseTimes('ms', { current: '2.1.2', target: '2.1.3' })

    expect(base.windows).toEqual([
      undefined,
      { current: '2.1.2', target: '2.1.3' },
    ])
  })

  it('answers quarantined when the gate lets no version through', async () => {
    const base = session(
      { ok: true, package: capturedPackage('ms', { source: 'packument' }) },
      {},
    )
    expect(
      await withReleaseAgeGate(base, () => gate(), now).lookup('ms'),
    ).toEqual({
      ok: false,
      name: 'ms',
      kind: 'quarantined',
      reason: 'every version is younger than npmMinimalAgeGate (1440 minutes)',
    })
  })

  it("keeps only the times of versions the gate lets through, for cooldown's fallbacks", async () => {
    const base = session(
      { ok: true, package: capturedPackage('ms') },
      { '2.1.2': '2019-06-06T17:31:55Z', '2.1.3': '2020-12-08T13:54:35Z' },
    )
    expect(
      await withReleaseAgeGate(base, () => gate(), now).releaseTimes('ms'),
    ).toEqual({ '2.1.2': '2019-06-06T17:31:55Z' })
  })

  it('passes everything through with no gate, and reads the gate only when asked', async () => {
    const lookup: PackageLookup = { ok: true, package: capturedPackage('ms') }
    const base = session(lookup, {})
    const read = jest.fn(() => undefined)
    const gated = withReleaseAgeGate(base, read, now)
    expect(read).not.toHaveBeenCalled()
    expect(await gated.lookup('ms')).toBe(lookup)
    expect(read).toHaveBeenCalled()
  })
})

// #177: a package's `modified` (no listed version is later) answers a gate that
// lets a version with no time through, so no publish times are read.
describe('withReleaseAgeGate and the packument modified (#177)', () => {
  const MODIFIED = '2025-09-08T19:56:54.242Z'
  const modifiedAt = Date.parse(MODIFIED)
  const DAY = 1440
  const allowed = (overrides: Partial<ReleaseAgeGate> = {}): ReleaseAgeGate =>
    gate({ setting: 'minimumReleaseAge', missingTime: 'allowed', ...overrides })
  const lookupWith = (modified: string | undefined): PackageLookup => ({
    ok: true,
    package: {
      ...capturedPackage('ms', { source: 'packument' }),
      ...(modified ? { modified } : {}),
    },
  })
  const times = {
    '2.1.2': '2019-06-06T17:31:55Z',
    '2.1.3': '2020-12-08T13:54:35Z',
  }
  const ask = async (
    lookup: PackageLookup,
    active: ReleaseAgeGate,
    at: number,
  ) => {
    const calls: string[] = []
    const base = {
      lookup: async (_name: string) => lookup,
      releaseTimes: async (name: string) => {
        calls.push(name)
        return times
      },
    }
    const result = await withReleaseAgeGate(
      base,
      () => active,
      () => at,
    ).lookup('ms')
    return { calls, result }
  }

  it.each([
    ['well past the gate', modifiedAt + 3 * DAY * 60_000, []],
    ['exactly at the gate (inclusive)', modifiedAt + DAY * 60_000, []],
    ['a millisecond inside the gate', modifiedAt + DAY * 60_000 - 1, ['ms']],
    ['inside the gate', modifiedAt + 60 * 60_000, ['ms']],
  ] as const)('minimumReleaseAge, %s', async (_label, at, calls) => {
    const lookup = lookupWith(MODIFIED)
    const { calls: asked, result } = await ask(
      lookup,
      allowed({ minutes: DAY }),
      at,
    )

    expect(asked).toEqual(calls)
    expect(result).toEqual(lookup)
  })

  it('still judges a version with a time, whatever modified says', async () => {
    const at = modifiedAt + 3 * DAY * 60_000
    const pkg = capturedPackage('ms', { source: 'packument' })
    const { calls, result } = await ask(
      {
        ok: true,
        package: {
          ...pkg,
          modified: MODIFIED,
          versions: pkg.versions.map((v) =>
            v.version === '2.1.3'
              ? { ...v, publishedAt: new Date(at - 60 * 60_000).toISOString() }
              : v,
          ),
        },
      },
      allowed({ minutes: DAY }),
      at,
    )

    expect(calls).toEqual([])
    expect(result).toMatchObject({ ok: true, package: { latest: '2.1.2' } })
    expect(
      result.ok && result.package.versions.map((v) => v.version),
    ).not.toContain('2.1.3')
  })

  it('reads times under a gate that holds a version with no time, whatever modified says', async () => {
    const { calls } = await ask(
      lookupWith(MODIFIED),
      gate({ minutes: DAY }),
      modifiedAt + 30 * DAY * 60_000,
    )
    expect(calls).toEqual(['ms'])
  })

  it.each([
    ['before modified', '2025-01-01T00:00:00.000Z', ['ms']],
    ['at modified', MODIFIED, []],
    ['after modified', '2026-01-01T00:00:00.000Z', []],
  ])("npm's before, %s", async (_label, notAfter, calls) => {
    const { calls: asked } = await ask(
      lookupWith(MODIFIED),
      allowed({ minutes: 0, notAfter }),
      modifiedAt + 30 * DAY * 60_000,
    )
    expect(asked).toEqual(calls)
  })

  it('reads times when there is no modified, or it is unparseable or in the future', async () => {
    const at = modifiedAt + 30 * DAY * 60_000
    for (const modified of [undefined, 'soon', '2999-01-01T00:00:00.000Z']) {
      const { calls } = await ask(
        lookupWith(modified),
        allowed({ minutes: DAY }),
        at,
      )
      expect(calls).toEqual(['ms'])
    }
  })

  it('asks nothing of a lookup that carries every time, as before', async () => {
    const { calls } = await ask(
      { ok: true, package: capturedPackage('ms') },
      allowed({ minutes: DAY }),
      modifiedAt,
    )
    expect(calls).toEqual([])
  })

  it('uses the scope minutes of the package', async () => {
    const lookup: PackageLookup = {
      ok: true,
      package: {
        ...capturedPackage('types-ms', { source: 'packument' }),
        name: '@acme/ms',
        modified: MODIFIED,
      },
    }
    const calls: string[] = []
    const base = {
      lookup: async (_name: string) => lookup,
      releaseTimes: async (name: string) => {
        calls.push(name)
        return {}
      },
    }
    await withReleaseAgeGate(
      base,
      () => allowed({ minutes: 0, scopes: { '@acme': DAY } }),
      () => modifiedAt + 60_000,
    ).lookup('@acme/ms')
    expect(calls).toEqual(['@acme/ms'])
  })
})
