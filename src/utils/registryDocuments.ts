import semver from 'semver'
import type { RegistryVersion } from '@/types'
import { isRecord } from './isRecord'

const isCanonical = (version: unknown): version is string =>
  typeof version === 'string' && semver.valid(version) === version

const timestamp = (value: unknown): string | undefined =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value))
    ? value
    : undefined

const byVersion = (a: RegistryVersion, b: RegistryVersion): number =>
  semver.compare(a.version, b.version)

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
  return versions.sort(byVersion)
}

/**
 * The versions and `dist-tags.latest` of an abbreviated or full packument.
 * npm treats an empty `deprecated` string as not deprecated.
 */
export const parsePackument = (
  body: unknown,
): { latest?: string; versions: RegistryVersion[] } | undefined => {
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
  return {
    ...(isCanonical(latest) ? { latest } : {}),
    versions: versions.sort(byVersion),
  }
}
