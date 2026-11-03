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
