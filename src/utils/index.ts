import { exec } from 'child_process'
import { promisify } from 'util'

export const execAsync = promisify(exec)

export { DEFAULT_CONFIG, loadConfig, saveJsonConfig } from './config'
export { checkIfFileExists } from './files'
export { default as logger } from './logger'
export type { GroupedPackages } from './packageGrouper'
export { getSortedGroupNames, groupAndSortPackages } from './packageGrouper'
export { default as updateChecker } from './updateChecker'
