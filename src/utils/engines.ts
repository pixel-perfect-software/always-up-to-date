import semver from 'semver'

import logger from './logger'

/**
 * The Node version autd runs on, or null under Bun, which reports the Node
 * version it emulates (the M5 binary has no Node to judge against).
 */
export const runningNode = (
  versions: { node?: string; bun?: string } = process.versions,
): string | null => (versions.bun ? null : (versions.node ?? null))

/** `*`, `x`, `>=0`: every version, so no constraint. */
const universal = (range: string): boolean =>
  semver.subset('>=0.0.0', range, { includePrerelease: true })

/**
 * The `engines.node` a project declares, when it is a real constraint: a
 * non-empty string semver accepts that is not universal. Anything else
 * (absent, `*`, `>=0`) declares nothing; an invalid or non-string value also
 * logs a debug line naming `file`, and the running Node is judged instead.
 */
export const declaredNodeRange = (
  value: unknown,
  file: string,
): string | undefined => {
  if (value === undefined) return undefined
  const range = typeof value === 'string' ? value.trim() : undefined
  if (range === undefined || (range !== '' && !semver.validRange(range))) {
    logger.debug(
      `engines.node in ${file} isn't a semver range; it declares nothing`,
    )
    return undefined
  }
  if (range === '' || universal(range)) return undefined
  return range
}

interface NodeSide {
  /** The project's declared `engines.node`, a valid non-universal range. */
  declared?: string
  /** The Node the project runs on: autd's, or the manager's own setting. */
  running: string | null
  /** What `running` is called in the reason; `running node` by default. */
  runningLabel?: string
}

/**
 * Why a target whose `engines.node` is `targetRange` is held, else undefined.
 * The declared range wins: every Node the project allows must fit the target
 * (`semver.subset`). Without one, the running Node must satisfy it. An
 * invalid or universal target range holds nothing, and neither does having
 * neither side to judge by.
 */
export const enginesHold = (
  targetRange: string,
  { declared, running, runningLabel = 'running node' }: NodeSide,
): string | undefined => {
  const target = targetRange.trim()
  if (!semver.validRange(target) || universal(target)) return undefined
  if (declared !== undefined && semver.validRange(declared)) {
    return semver.subset(declared, target, { includePrerelease: true })
      ? undefined
      : `engines: needs node ${target} (the project declares ${declared})`
  }
  if (running === null) return undefined
  return semver.satisfies(running, target, { includePrerelease: true })
    ? undefined
    : `engines: needs node ${target} (${runningLabel} ${running})`
}

/** Whether `targetRange` excludes the project's Node (what #200 asks of each candidate). */
export const excludesNode = (targetRange: string, side: NodeSide): boolean =>
  enginesHold(targetRange, side) !== undefined
