import semver from 'semver'

import type { UpdateResult, VersionManifest } from '@/types'
import { enginesHold, npmAcceptsNode, shownRange } from '@/utils/engines'
import logger from '@/utils/logger'
import type { RegistrySession } from '@/utils/registry'
import type { TargetManifests } from '@/utils/targetManifests'

/** Most versions below the target read per (name, target, range, current). */
export const ENGINES_WALK_LIMIT = 5

/** What the cooldown says of one version; `ageDays` is kept as the row's `releaseAge`. */
interface VersionCooldown {
  gated: boolean
  ageDays: number | undefined
}

interface Fit {
  version: string
  manifest: VersionManifest
  ageDays: number | undefined
  /** The target's `engines.node`, for the reason. */
  range: string
  /** The declared `engines.node` the walk was judged by, when it drove it. */
  declared: string | undefined
}

const stepType = (from: string, to: string) =>
  semver.valid(from) && semver.valid(to) ? semver.diff(from, to) : null

const keyOf = (name: string, version: string): string => `${name}@${version}`

/**
 * npm's preference for a version its Node runs (#200). npm picks the highest
 * version the range allows whose `engines.node` fits (npm-pick-manifest's
 * `engineOk`, judged by `npmAcceptsNode`), so a moving in-range row whose
 * target excludes `node` moves to the newest version below it that fits, and
 * `npm install` of that exact version is what the plan then pins.
 *
 * When the project declares `engines.node` (#233), a target it excludes is
 * walked too, and a candidate must fit both npm's Node and the declared
 * range, so the row lands where #199 will not hold it.
 *
 * Only a row at `wanted` is walked: a past-the-range target is the policy's
 * choice, and a cooldown fallback is already an exact pin. Candidates are the
 * versions the session already looked up (so no request, and already
 * release-age gated) that satisfy the declared range, are above `current`
 * and below the target and are not deprecated, newest first, at most `limit`.
 * An unknown manifest stops the walk and keeps the target, which #199 then
 * judges; so does reaching the cap. Returns the rows and the manifests with
 * each fit added, for the passes that follow to judge it.
 *
 * Known differences from npm-pick-manifest, all rare: an untagged fitting
 * version above an excluded `latest` tag (npm picks it, this walks down and
 * pins lower); a deprecated fitting version beats a non-deprecated excluded
 * one in npm's sort (the target stays, and #199 holds it); `engines.npm` is
 * not modeled; npm's `loose` satisfies against `wantedVersion`'s strict one.
 */
export const fitRunningNode = async (
  rows: UpdateResult[],
  {
    node,
    manifests,
    registry,
    lookupName,
    rangeOf,
    declaredOf,
    cooldownOf,
    limit = ENGINES_WALK_LIMIT,
  }: {
    node: string | null
    manifests: TargetManifests
    registry: Partial<Pick<RegistrySession, 'lookedUp' | 'versionManifest'>>
    lookupName: (row: UpdateResult) => string
    /** The range the row's manifest declares for it. */
    rangeOf: (row: UpdateResult) => string | undefined
    /**
     * The `engines.node` the row's owning manifest declares (a real
     * constraint, see `declaredNodeRange`), if any. A candidate must fit it
     * as well as npm's Node: `enginesHold`'s rule, which #199 judges the
     * move by afterwards.
     */
    declaredOf?: (row: UpdateResult) => string | undefined
    /** Whether the cooldown holds `version` for the row; absent when it is off. */
    cooldownOf?: (
      row: UpdateResult,
      version: string,
    ) => Promise<VersionCooldown>
    limit?: number
  },
): Promise<{ rows: UpdateResult[]; manifests: TargetManifests }> => {
  const { lookedUp, versionManifest } = registry
  const atWanted = (row: UpdateResult): boolean =>
    row.updated &&
    row.target !== undefined &&
    (row.target === row.wanted ||
      (semver.valid(row.target) !== null &&
        semver.valid(row.wanted) !== null &&
        semver.eq(row.target, row.wanted)))
  if (!lookedUp || !versionManifest) return { rows, manifests }
  if (node === null) {
    if (rows.some(atWanted)) {
      logger.debug("No Node runs autd: npm's engines preference isn't mirrored")
    }
    return { rows, manifests }
  }

  const walks = new Map<string, Promise<Fit | undefined>>()
  const added = new Map<string, VersionManifest>()

  const walkFor = async (
    row: UpdateResult,
    target: string,
    enginesNode: string,
    range: string | undefined,
    declared: string | undefined,
    declaredHolds: boolean,
  ): Promise<Fit | undefined> => {
    const name = lookupName(row)
    if (range === undefined) {
      logger.debug(`engines: no declared range for ${name}; keeping ${target}`)
      return undefined
    }
    const lookup = await lookedUp(name)
    if (!lookup?.ok) {
      logger.debug(`engines: no lookup of ${name}; keeping ${target}`)
      return undefined
    }
    const candidates = lookup.package.versions
      .filter(
        (entry) =>
          semver.valid(entry.version) !== null &&
          !entry.deprecated &&
          semver.satisfies(entry.version, range) &&
          (!semver.valid(row.current) ||
            semver.gt(entry.version, row.current)) &&
          semver.lt(entry.version, target),
      )
      .map((entry) => entry.version)
      .sort(semver.rcompare)
      .slice(0, limit)
    for (const version of candidates) {
      const manifest = await versionManifest(name, version)
      if (!manifest) {
        logger.debug(
          `engines: no manifest for ${keyOf(name, version)}; keeping ${target}`,
        )
        return undefined
      }
      if (!npmAcceptsNode(manifest.enginesNode, node)) continue
      if (
        declared !== undefined &&
        manifest.enginesNode !== undefined &&
        enginesHold(manifest.enginesNode, { declared, running: null })
      ) {
        continue
      }
      const cooldown = cooldownOf ? await cooldownOf(row, version) : undefined
      if (cooldown?.gated) continue
      logger.debug(
        `engines: npm skips ${keyOf(name, target)} (needs node ${enginesNode}, running node ${node}); moving to ${version}`,
      )
      return {
        version,
        manifest,
        ageDays: cooldown?.ageDays,
        range: enginesNode,
        declared: declaredHolds ? declared : undefined,
      }
    }
    logger.debug(
      `engines: none of the ${candidates.length} newest versions of ${name} below ${target} fits node ${node}${declared === undefined ? '' : ` and the declared ${declared}`}; keeping ${target}`,
    )
    return undefined
  }

  const moved = await Promise.all(
    rows.map(async (row): Promise<UpdateResult> => {
      const { target } = row
      if (!atWanted(row) || target === undefined) return row
      const name = lookupName(row)
      const own = manifests.get(keyOf(name, target))
      if (!own?.enginesNode) return row
      const declared = declaredOf?.(row)
      const declaredHolds =
        declared !== undefined &&
        enginesHold(own.enginesNode, { declared, running: null }) !== undefined
      if (npmAcceptsNode(own.enginesNode, node) && !declaredHolds) return row
      const range = rangeOf(row)
      const key = [keyOf(name, target), range, row.current, declared].join('|')
      let walk = walks.get(key)
      if (!walk) {
        walk = walkFor(
          row,
          target,
          own.enginesNode,
          range,
          declared,
          declaredHolds,
        )
        walks.set(key, walk)
      }
      const fit = await walk
      if (!fit) return row
      added.set(keyOf(name, fit.version), fit.manifest)
      return {
        ...row,
        target: fit.version,
        updateType: stepType(row.current, fit.version),
        reason: {
          code: 'engines-fallback',
          message: `engines: ${target} needs node ${shownRange(fit.range)} (${
            fit.declared === undefined
              ? `running node ${node}`
              : `the project declares ${fit.declared}`
          })`,
        },
        releaseAge: fit.ageDays,
      }
    }),
  )
  return {
    rows: moved,
    manifests: added.size === 0 ? manifests : new Map([...manifests, ...added]),
  }
}
