import type { UpdateResult } from '@/types'
import type { DeclaredDependency } from '@/utils/dependencySpecs'
import type { RegistrySession } from '@/utils/registry'
import type { TargetManifests } from '@/utils/targetManifests'
import type { UpdatePolicy } from '@/utils/updateChecker'

/**
 * What the plan asks of the registry session: `releaseTimes` always, and
 * `lookup`, `lookedUp` and `versionManifest` when the session has them
 * (`FilterPackagesOptions.registry` says what each is for).
 */
export type PlanRegistry = Pick<RegistrySession, 'releaseTimes'> &
  Partial<Pick<RegistrySession, 'lookup' | 'lookedUp' | 'versionManifest'>>

/**
 * What a row's manifest declares for it, by manifest key
 * (`FilterPackagesOptions.declared`).
 */
export type DeclaredOf = (row: {
  name: string
  workspace?: string
}) => Pick<DeclaredDependency, 'name' | 'spec'> | undefined

/**
 * A pass that judges each moving row by its target's own manifest (`engines.node`
 * today; license and peers are judged elsewhere): it holds or warns, never
 * moves a row. An unknown manifest (undefined) is a state each pass decides
 * for itself.
 */
export type ManifestPass = (
  rows: UpdateResult[],
  context: {
    manifests: TargetManifests
    lookupName: (row: UpdateResult) => string
    policy: UpdatePolicy
  },
) => UpdateResult[]
