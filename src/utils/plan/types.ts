import type { RegistrySession } from '../registry'

/**
 * What the plan asks of the registry session: `releaseTimes` always, and
 * `lookup`, `lookedUp` and `versionManifest` when the session has them
 * (`FilterPackagesOptions.registry` says what each is for).
 */
export type PlanRegistry = Pick<RegistrySession, 'releaseTimes'> &
  Partial<Pick<RegistrySession, 'lookup' | 'lookedUp' | 'versionManifest'>>
