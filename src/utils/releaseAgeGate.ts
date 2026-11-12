import semver from 'semver'
import type {
  PackageLookup,
  RegistryPackage,
  RegistryVersion,
  ReleaseAgeExemption,
  ReleaseAgeGate,
  ReleaseWindow,
} from '@/types'
import logger from './logger'
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

const nameExempt = (exemption: ReleaseAgeExemption, name: string): boolean =>
  exemption.name === name ||
  (exemption.glob !== 'none' &&
    globMatches(exemption.name, name, exemption.glob))

const versionExempt = (
  exemption: ReleaseAgeExemption,
  version: string,
): boolean =>
  exemption.versions === undefined ||
  (semver.validRange(exemption.versions) !== null &&
    semver.satisfies(version, exemption.versions))

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
  exemptions.some(
    (exemption) =>
      nameExempt(exemption, name) && versionExempt(exemption, version),
  )

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

/** Whether a version published at `at` is old enough: at least `minutes` before `now`, and not after `notAfter`. */
const clearsAge = (
  at: number,
  minutes: number,
  gate: ReleaseAgeGate,
  now: number,
): boolean => {
  if (gate.notAfter !== undefined && at > Date.parse(gate.notAfter)) {
    return false
  }
  return (now - at) / 60_000 >= minutes
}

/**
 * Whether the package's `modified` (no listed version is later) clears the
 * gate, so every version passes with no publish time: a time-less version is
 * allowed only where the manager lets one through. Never under a gate that
 * holds a version with no time (berry, #166).
 */
const clearedByModified = (
  pkg: RegistryPackage,
  gate: ReleaseAgeGate,
  now: number,
): boolean => {
  if (gate.missingTime !== 'allowed' || pkg.modified === undefined) return false
  const at = Date.parse(pkg.modified)
  return (
    !Number.isNaN(at) &&
    clearsAge(at, gateMinutesFor(pkg.name, gate), gate, now)
  )
}

/**
 * Whether the gate lets `version` through: exempt (`exempt` holds the
 * exemptions whose name already matched the package), or published at least its
 * minutes before `now` and not after its `notAfter`. A version with no known
 * time passes only where the manager lets one through (`missingTime`).
 */
const passes = (
  exempt: readonly ReleaseAgeExemption[],
  version: string,
  published: string | undefined,
  minutes: number,
  gate: ReleaseAgeGate,
  now: number,
): boolean => {
  if (exempt.some((exemption) => versionExempt(exemption, version))) return true
  const at = published === undefined ? Number.NaN : Date.parse(published)
  if (Number.isNaN(at)) return gate.missingTime === 'allowed'
  return clearsAge(at, minutes, gate, now)
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
  const exempt = gate.exempt.filter((e) => nameExempt(e, pkg.name))
  const versions = pkg.versions.filter((v) =>
    passes(
      exempt,
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
 * never lands on one the gate holds, and the window a cooldown asks about
 * goes through to the session. Times missing from a lookup (a packument
 * without `time`, and no deps.dev time to add) come from `releaseTimes` for
 * every version, through the reader's limiter and cache; a version still
 * without one passes only where the manager lets it. `gate` is read on the
 * first lookup, so opening a project reads nothing. Each name is gated once
 * per session, and `lookedUp` returns that answer (#195).
 */
export const withReleaseAgeGate = <
  S extends Pick<RegistrySession, 'lookup' | 'releaseTimes'>,
>(
  session: S,
  gate: () => ReleaseAgeGate | undefined,
  now: () => number = Date.now,
): S & Pick<RegistrySession, 'lookedUp'> => {
  // Each name's gated answer, so a repeat (the plan's `lookedUp`, #195) sees
  // the versions discovery saw.
  const lookups = new Map<string, Promise<PackageLookup>>()
  const gatedLookup = async (name: string): Promise<PackageLookup> => {
    const result = await session.lookup(name)
    const active = gate()
    if (!result.ok || !active || !isActive(name, active)) return result
    const pkg = result.package
    const untimed = pkg.versions.some((v) => !v.publishedAt)
    // `modified` answers only for the versions with no time; one with a time
    // is still judged by it.
    const cleared = untimed && clearedByModified(pkg, active, now())
    if (cleared) {
      logger.debug(
        `No publish times needed for ${name}: last modified ${pkg.modified}, past ${active.setting}`,
      )
    }
    const times = untimed && !cleared ? await session.releaseTimes(name) : {}
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
  }
  return {
    ...session,
    lookup: (name: string): Promise<PackageLookup> => {
      let request = lookups.get(name)
      if (!request) {
        request = gatedLookup(name)
        lookups.set(name, request)
      }
      return request
    },
    lookedUp: (name: string) => lookups.get(name),
    releaseTimes: async (
      name: string,
      window?: ReleaseWindow,
    ): Promise<Record<string, string>> => {
      const times = await session.releaseTimes(name, window)
      const active = gate()
      if (!active || !isActive(name, active)) return times
      const minutes = gateMinutesFor(name, active)
      const at = now()
      const exempt = active.exempt.filter((e) => nameExempt(e, name))
      return Object.fromEntries(
        Object.entries(times).filter(([version, published]) =>
          passes(exempt, version, published, minutes, active, at),
        ),
      )
    },
  }
}
