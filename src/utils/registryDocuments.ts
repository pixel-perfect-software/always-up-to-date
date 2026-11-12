import semver from 'semver'
import type { RegistryVersion, VersionManifest } from '@/types'
import { isRecord } from './isRecord'
import { licenseField } from './license'

const isCanonical = (version: unknown): version is string =>
  typeof version === 'string' && semver.valid(version) === version

const timestamp = (value: unknown): string | undefined =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? value
    : undefined

/**
 * `versions` ascending by semver, each version parsed once. Versions that
 * differ only in build metadata compare equal, and the sort is stable, so
 * they keep the document's order, as sorting with `semver.compare` does.
 */
const sortedByVersion = (versions: RegistryVersion[]): RegistryVersion[] =>
  versions
    .map((entry) => ({ entry, parsed: new semver.SemVer(entry.version) }))
    .sort((a, b) => a.parsed.compare(b.parsed))
    .map(({ entry }) => entry)

/** `latest` from the registry's `/-/package/<name>/dist-tags` body. */
export const parseDistTags = (body: unknown): string | undefined => {
  if (!isRecord(body)) return undefined
  const { latest } = body
  return isCanonical(latest) ? latest : undefined
}

/** The versions of a deps.dev package document, ascending; undefined if it isn't one. */
export const parseDepsDevPackage = (
  body: unknown,
): RegistryVersion[] | undefined => {
  if (!isRecord(body) || !Array.isArray(body.versions)) return undefined
  const versions: RegistryVersion[] = []
  for (const entry of body.versions as unknown[]) {
    if (!isRecord(entry) || !isRecord(entry.versionKey)) continue
    const { version } = entry.versionKey
    if (!isCanonical(version)) continue
    const publishedAt = timestamp(entry.publishedAt)
    const reason = entry.deprecatedReason
    versions.push({
      version,
      deprecated: entry.isDeprecated === true,
      ...(typeof reason === 'string' && reason
        ? { deprecatedReason: reason }
        : {}),
      ...(publishedAt ? { publishedAt } : {}),
    })
  }
  return sortedByVersion(versions)
}

export interface ParsedPackument {
  latest?: string
  /** The document's top-level `modified` (abbreviated packuments only; a full one has `time.modified`). */
  modified?: string
  versions: RegistryVersion[]
}

/**
 * The versions and `dist-tags.latest` of an abbreviated or full packument.
 * npm treats an empty `deprecated` string as not deprecated.
 */
export const parsePackument = (body: unknown): ParsedPackument | undefined => {
  if (!isRecord(body) || !isRecord(body.versions)) return undefined
  const time = isRecord(body.time) ? body.time : {}
  const versions: RegistryVersion[] = []
  for (const [version, manifest] of Object.entries(body.versions)) {
    if (!isCanonical(version)) continue
    const deprecated = isRecord(manifest) ? manifest.deprecated : undefined
    const reason = typeof deprecated === 'string' ? deprecated : undefined
    const publishedAt = Object.hasOwn(time, version)
      ? timestamp(time[version])
      : undefined
    versions.push({
      version,
      deprecated: deprecated === true || Boolean(reason),
      ...(reason ? { deprecatedReason: reason } : {}),
      ...(publishedAt ? { publishedAt } : {}),
    })
  }
  const tags = body['dist-tags']
  const latest = isRecord(tags) ? tags.latest : undefined
  const modified = timestamp(body.modified)
  return {
    ...(isCanonical(latest) ? { latest } : {}),
    ...(modified ? { modified } : {}),
    versions: sortedByVersion(versions),
  }
}

/** A dependency field's string-valued entries; nothing for anything else. */
const stringEntries = (field: unknown): Record<string, string> =>
  isRecord(field)
    ? Object.fromEntries(
        Object.entries(field).filter(
          (entry): entry is [string, string] => typeof entry[1] === 'string',
        ),
      )
    : {}

const trimmed = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  return text === '' ? undefined : text
}

/**
 * One version's manifest (`GET <registry>/<name>/<version>`, #196), or
 * undefined unless it is a record naming that version of that package (a
 * registry's 404 body is a JSON string). Non-string peer ranges are dropped;
 * an empty `deprecated` string is not deprecated, as npm reads it.
 */
export const parseVersionManifest = (
  body: unknown,
  expected: { name: string; version: string },
): VersionManifest | undefined => {
  if (
    !isRecord(body) ||
    body.name !== expected.name ||
    body.version !== expected.version
  )
    return undefined
  const license = licenseField(body)
  const enginesNode = isRecord(body.engines)
    ? trimmed(body.engines.node)
    : undefined
  const peerDependencies = stringEntries(body.peerDependencies)
  const meta = isRecord(body.peerDependenciesMeta)
    ? body.peerDependenciesMeta
    : {}
  const optionalPeers = Object.entries(meta)
    .filter(([, entry]) => isRecord(entry) && entry.optional === true)
    .map(([peer]) => peer)
    .sort()
  const { deprecated } = body
  const reason = typeof deprecated === 'string' ? deprecated : undefined
  return {
    name: expected.name,
    version: expected.version,
    ...(license ? { license } : {}),
    ...(enginesNode ? { enginesNode } : {}),
    peerDependencies,
    optionalPeers,
    dependencies: stringEntries(body.dependencies),
    optionalDependencies: stringEntries(body.optionalDependencies),
    deprecated: deprecated === true || Boolean(reason),
    ...(reason ? { deprecatedReason: reason } : {}),
  }
}
