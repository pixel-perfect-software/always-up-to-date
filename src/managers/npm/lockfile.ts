import fs from 'fs'
import path from 'path'

import { isRecord } from '@/utils/isRecord'

/** One `packages` entry of package-lock.json (lockfileVersion 2 and 3). */
export interface LockedEntry {
  name?: unknown
  version?: unknown
  link?: unknown
  resolved?: unknown
  dependencies?: unknown
  devDependencies?: unknown
  optionalDependencies?: unknown
  peerDependencies?: unknown
}

/** The `packages` of the project's package-lock.json, undefined when it is missing or unreadable. */
export const readLockfile = (
  cwd: string,
): Record<string, LockedEntry> | undefined => {
  try {
    const packages = JSON.parse(
      fs.readFileSync(path.join(cwd, 'package-lock.json'), 'utf8'),
    ).packages
    return isRecord(packages)
      ? (packages as Record<string, LockedEntry>)
      : undefined
  } catch {
    return undefined
  }
}
