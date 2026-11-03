import semver from 'semver'
import type {
  PackageLookup,
  RegistryPackage,
  RegistryVersion,
  ReleaseAgeExemption,
  ReleaseAgeGate,
} from '@/types'
import type { RegistrySession } from './registry'

/**
 * A manager's release-age gate (#166, #168): versions published less than its
 * minutes ago are never installed, so autd never proposes them. A security
 * setting of the manager's, which autd never overrides: yarn berry's
 * `npmMinimalAgeGate` and pnpm's `minimumReleaseAge` (one day unless set),
 * bun's `minimumReleaseAge` and npm's `min-release-age` / `before` (off
 * unless set). Verified 2026-11-03 on yarn 4.18.1, pnpm 12.16.1, bun 1.4.4
 * and npm 12.2.1 (the rows are cases in `__tests__/releaseAgeGates.test.ts`,
 * `__tests__/utils/releaseAgeGate.test.ts` and `__tests__/managers/yarnrcYml.test.ts`).
 */

/** The gate's minutes for `name`: its scope's own when the manager configures that scope, else the top level's. */
export const gateMinutesFor = (name: string, gate: ReleaseAgeGate): number => {
  if (name.startsWith('@')) {
    const scoped = gate.scopes[name.slice(0, name.indexOf('/'))]
    if (scoped !== undefined) return scoped
  }
  return gate.minutes
}

/** A name glob: `*` and `?` stay within a path segment (`segment`) or cross them (`any`); `**` always crosses. */
const globMatches = (
  glob: string,
  name: string,
  star: 'segment' | 'any',
): boolean => {
  let pattern = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      pattern += '.*'
      i++
    } else if (c === '*') pattern += star === 'any' ? '.*' : '[^/]*'
    else if (c === '?') pattern += star === 'any' ? '.' : '[^/]'
    else pattern += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${pattern}$`).test(name)
}

/**
 * Whether one of `exemptions` lets `name@version` through: its name matches
 * (exactly, or as its manager's glob), and it lists no versions or the
 * version satisfies them. Versions that don't parse exempt none.
 */
export const isExempt = (
  name: string,
  version: string,
  exemptions: readonly ReleaseAgeExemption[],
): boolean =>
  exemptions.some((exemption) => {
    const matches =
      exemption.name === name ||
      (exemption.glob !== 'none' &&
        globMatches(exemption.name, name, exemption.glob))
    if (!matches) return false
    if (exemption.versions === undefined) return true
    return (
      semver.validRange(exemption.versions) !== null &&
      semver.satisfies(version, exemption.versions)
    )
  })

/** A pattern written `<name>@<versions>` (a scope's `@` first is part of the name); `<name>` alone exempts every version. */
export const exemptionOf = (
  pattern: string,
  glob: ReleaseAgeExemption['glob'],
): ReleaseAgeExemption => {
  const at = pattern.indexOf('@', 1)
  return at === -1
    ? { name: pattern, glob }
    : { name: pattern.slice(0, at), glob, versions: pattern.slice(at + 1) }
}

/** Whether the gate holds anything back for `name`: an age, or npm's `before`. */
const isActive = (name: string, gate: ReleaseAgeGate): boolean =>
  gateMinutesFor(name, gate) > 0 || gate.notAfter !== undefined

/**
 * Whether the gate lets `version` through: exempt, or published at least its
 * minutes before `now` and not after its `notAfter`. A version with no known
 * time passes only where the manager lets one through (`missingTime`).
 */
const passes = (
  name: string,
  version: string,
  published: string | undefined,
  minutes: number,
  gate: ReleaseAgeGate,
  now: number,
): boolean => {
  if (isExempt(name, version, gate.exempt)) return true
  const at = published === undefined ? Number.NaN : Date.parse(published)
  if (Number.isNaN(at)) return gate.missingTime === 'allowed'
  if (gate.notAfter !== undefined && at > Date.parse(gate.notAfter)) {
    return false
  }
  return (now - at) / 60_000 >= minutes
}

/**
 * `pkg` with only the versions the gate lets through, or undefined when it
 * lets none through. `latest` stays the registry's when it passes, else the
 * highest stable version below it that does, else the highest one that does.
 */
export const gatePackage = (
  pkg: RegistryPackage,
  gate: ReleaseAgeGate,
  times: Record<string, string>,
  now: number,
): RegistryPackage | undefined => {
  const minutes = gateMinutesFor(pkg.name, gate)
  if (!isActive(pkg.name, gate)) return pkg
  const versions = pkg.versions.filter((v) =>
    passes(
      pkg.name,
      v.version,
      v.publishedAt ?? times[v.version],
      minutes,
      gate,
      now,
    ),
  )
  if (versions.length === 0) return undefined
  const has = (version: string) => versions.some((v) => v.version === version)
  const stable = versions.filter((v) => semver.prerelease(v.version) === null)
  const highest = (list: RegistryVersion[]) =>
    list.reduce<string | undefined>(
      (best, v) =>
        best === undefined || semver.gt(v.version, best) ? v.version : best,
      undefined,
    )
  const latest = has(pkg.latest)
    ? pkg.latest
    : (highest(stable.filter((v) => semver.lt(v.version, pkg.latest))) ??
      highest(stable) ??
      (highest(versions) as string))
  return { ...pkg, versions, latest }
}

/**
 * `session` with the manager's release-age gate on every lookup (#166):
 * `lookup` answers with the versions the gate lets through, and a package it
 * lets none through is a `quarantined` failure, which discovery leaves out.
 * `releaseTimes` keeps only those versions' times, so a cooldown fallback
 * never lands on one the gate holds. Times missing from a lookup (a
 * packument without `time`) come from `releaseTimes`, the full packument;
 * a version still without one passes only where the manager lets it. `gate` is
 * read on the first lookup, so opening a project reads nothing.
 */
export const withReleaseAgeGate = <
  S extends Pick<RegistrySession, 'lookup' | 'releaseTimes'>,
>(
  session: S,
  gate: () => ReleaseAgeGate | undefined,
  now: () => number = Date.now,
): S => ({
  ...session,
  lookup: async (name: string): Promise<PackageLookup> => {
    const result = await session.lookup(name)
    const active = gate()
    if (!result.ok || !active || !isActive(name, active)) return result
    const pkg = result.package
    const times = pkg.versions.every((v) => v.publishedAt)
      ? {}
      : await session.releaseTimes(name)
    const gated = gatePackage(pkg, active, times, now())
    if (gated) return { ok: true, package: gated }
    return {
      ok: false,
      name,
      kind: 'quarantined',
      reason: active.notAfter
        ? `no version passes ${active.setting} (published before ${active.notAfter}${gateMinutesFor(name, active) > 0 ? ` and ${gateMinutesFor(name, active)} minutes old` : ''})`
        : `every version is younger than ${active.setting} (${gateMinutesFor(name, active)} minutes)`,
    }
  },
  releaseTimes: async (name: string): Promise<Record<string, string>> => {
    const times = await session.releaseTimes(name)
    const active = gate()
    if (!active || !isActive(name, active)) return times
    const minutes = gateMinutesFor(name, active)
    const at = now()
    return Object.fromEntries(
      Object.entries(times).filter(([version, published]) =>
        passes(name, version, published, minutes, active, at),
      ),
    )
  },
})
