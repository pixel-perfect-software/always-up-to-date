import semver from 'semver'
import type {
  PackageLookup,
  RegistryPackage,
  RegistryVersion,
  ReleaseAgeGate,
} from '@/types'
import type { RegistrySession } from './registry'

/**
 * A manager's release-age gate (#166): versions published less than its
 * minutes ago are never installed, so autd never proposes them. A security
 * default of the manager's: yarn berry's `npmMinimalAgeGate` (one day unless
 * set). Verified on yarn 4.18.1, 2026-11-03 (rows in
 * `.claude/plans/lockfile-discovery.md`).
 */

/** The gate's minutes for `name`: its scope's own when the manager configures that scope, else the top level's. */
export const gateMinutesFor = (name: string, gate: ReleaseAgeGate): number => {
  if (name.startsWith('@')) {
    const scoped = gate.scopes[name.slice(0, name.indexOf('/'))]
    if (scoped !== undefined) return scoped
  }
  return gate.minutes
}

/** A name glob as berry matches one (micromatch): `*` and `?` stay within a path segment, `**` crosses them. */
const globMatches = (glob: string, name: string): boolean => {
  let pattern = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]
    if (c === '*' && glob[i + 1] === '*') {
      pattern += '.*'
      i++
    } else if (c === '*') pattern += '[^/]*'
    else if (c === '?') pattern += '[^/]'
    else pattern += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${pattern}$`).test(name)
}

/**
 * Whether one of `patterns` exempts `name@version`, as berry's
 * `npmPreapprovedPackages` does: a descriptor or name glob, with an optional
 * range after the name (`p-exempt`, `@acme/*@^1.0.0`). No range exempts every
 * version; a range that doesn't parse exempts none.
 */
export const isExempt = (
  name: string,
  version: string,
  patterns: readonly string[],
): boolean =>
  patterns.some((pattern) => {
    const at = pattern.indexOf('@', 1)
    const glob = at === -1 ? pattern : pattern.slice(0, at)
    const range = at === -1 ? undefined : pattern.slice(at + 1)
    if (glob !== name && !globMatches(glob, name)) return false
    if (range === undefined) return true
    return semver.validRange(range) !== null && semver.satisfies(version, range)
  })

/** Whether the gate lets `version` through: exempt, or published at least its minutes before `now`. A version with no known time does not pass. */
const passes = (
  name: string,
  version: string,
  published: string | undefined,
  minutes: number,
  gate: ReleaseAgeGate,
  now: number,
): boolean => {
  if (isExempt(name, version, gate.exempt)) return true
  if (published === undefined) return false
  const at = Date.parse(published)
  return !Number.isNaN(at) && (now - at) / 60_000 >= minutes
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
  if (minutes <= 0) return pkg
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
 * a version still without one doesn't pass, as berry treats it. `gate` is
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
    if (!result.ok || !active || gateMinutesFor(name, active) <= 0) {
      return result
    }
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
      reason: `every version is younger than ${active.setting} (${gateMinutesFor(name, active)} minutes)`,
    }
  },
  releaseTimes: async (name: string): Promise<Record<string, string>> => {
    const times = await session.releaseTimes(name)
    const active = gate()
    const minutes = active ? gateMinutesFor(name, active) : 0
    if (!active || minutes <= 0) return times
    const at = now()
    return Object.fromEntries(
      Object.entries(times).filter(([version, published]) =>
        passes(name, version, published, minutes, active, at),
      ),
    )
  },
})
