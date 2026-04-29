import { exec } from 'child_process'
import { promisify } from 'util'

export const execAsync = promisify(exec)

export {
  CONFIG_SCHEMA_URL,
  DEFAULT_CONFIG,
  loadConfig,
  saveJsonConfig,
} from './config'
export {
  cooldownDaysFor,
  evaluateCooldown,
  isCooldownEnabled,
  normalizeCooldown,
} from './cooldown'
export { formatAgeDays, MS_PER_DAY, parseDuration } from './duration'
export { checkIfFileExists } from './files'
export { default as filterPackages } from './filterPackages'
export { default as logger } from './logger'
export { loadRegistryConfig } from './npmrcLoader'
export type { GroupedPackages } from './packageGrouper'
export { getSortedGroupNames, groupAndSortPackages } from './packageGrouper'
export { clearRegistryCache, fetchReleaseTimes } from './registry'
export { computeReleaseAges } from './releaseAges'
export { default as updateChecker } from './updateChecker'
