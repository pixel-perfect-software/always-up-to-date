import type { DeclaredDependency } from '@/utils/dependencySpecs'
import type { RegistrySession } from '@/utils/registry'

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
