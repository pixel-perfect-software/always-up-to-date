import type { UpdateResult, VersionManifest } from '@/types'
import type { RegistrySession } from './registry'

/**
 * Each moving target's own manifest (#196), keyed `<looked-up name>@<target>`;
 * undefined where the registry had no readable document. What #197-#199 hold
 * from.
 */
export type TargetManifests = ReadonlyMap<string, VersionManifest | undefined>

const keyOf = (name: string, version: string): string => `${name}@${version}`

/**
 * Reads the manifest of every moving row's target, once per name and target
 * however many manifests or aliases share it, by the name discovery looked up
 * (`lookupName`: an alias's target, #152). All at once: the reader's per-host
 * limiter bounds the requests. Empty, asking nothing, when the registry can't
 * read manifests (a unit test's fake) or no row moves.
 */
export const readTargetManifests = async (
  rows: readonly UpdateResult[],
  {
    registry,
    lookupName,
  }: {
    registry: Partial<Pick<RegistrySession, 'versionManifest'>>
    lookupName: (row: UpdateResult) => string
  },
): Promise<TargetManifests> => {
  const { versionManifest } = registry
  if (!versionManifest) return new Map()
  const pairs = new Map<string, { name: string; version: string }>()
  for (const row of rows) {
    if (!row.updated || !row.target) continue
    const name = lookupName(row)
    pairs.set(keyOf(name, row.target), { name, version: row.target })
  }
  return new Map(
    await Promise.all(
      [...pairs].map(
        async ([key, { name, version }]) =>
          [key, await versionManifest(name, version)] as const,
      ),
    ),
  )
}

/** The manifest read for a moving row's target, else undefined. */
export const targetManifestOf = (
  manifests: TargetManifests,
  row: UpdateResult,
  lookupName: (row: UpdateResult) => string,
): VersionManifest | undefined =>
  row.updated && row.target
    ? manifests.get(keyOf(lookupName(row), row.target))
    : undefined
