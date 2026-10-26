import semver, { type ReleaseType } from 'semver'
import type {
  AlwaysUpToDateConfig,
  ManifestPlan,
  PackageInfo,
  UpdateResult,
} from '@/types'
import { evaluateCooldown, isCooldownEnabled } from './cooldown'
import { formatAgeDays } from './duration'
import type { ControllingOverride } from './overrides'
import { type PeerRequirement, readInstalledPeers } from './peers'
import type { RegistrySession } from './registry'
import updateChecker, {
  policyFromConfig,
  type UpdatePolicy,
} from './updateChecker'
import { byPath, expandWorkspaces } from './workspaceRows'

interface FilterPackagesOptions {
  config: AlwaysUpToDateConfig
  targetPackages?: string[]
  cwd?: string
  /** Where the cooldown gate reads publish times; only asked when cooldown is on. */
  registry: Pick<RegistrySession, 'releaseTimes'>
  now?: number
  /** Packages pinned by an override the manager enforces; without it no package is held for one. */
  overrides?: Record<string, ControllingOverride>
}

/**
 * `semver.diff`, or null when either version isn't semver: managers report
 * versions such as yarn v1's `exotic` for an npm: alias, and `semver.diff`
 * throws on them.
 */
const stepType = (from: string, to: string): ReleaseType | null =>
  semver.valid(from) && semver.valid(to) ? semver.diff(from, to) : null

/**
 * Holds targets an installed package's peer range excludes. A range declared
 * by a package that is itself moving in this run doesn't count: its new
 * version's peers can't be known offline. Holding one package can expose a
 * conflict for another, so this repeats until nothing changes. A `latest`
 * rule still moves, with the conflict as a warning.
 */
const holdPeerConflicts = (
  results: UpdateResult[],
  peers: Map<string, PeerRequirement[]>,
  policy: UpdatePolicy,
): UpdateResult[] => {
  let current = results
  for (;;) {
    const moving = new Set(current.filter((r) => r.updated).map((r) => r.name))
    let changed = false

    current = current.map((result) => {
      const { name, target } = result
      if (!result.updated || !target || result.warning) return result

      const conflict = (peers.get(name) ?? []).find(
        (peer) =>
          !moving.has(peer.name) &&
          !semver.satisfies(target, peer.range, { includePrerelease: true }),
      )
      if (!conflict) return result

      const message = `peer conflict: ${conflict.name}@${conflict.version} needs ${name} ${conflict.range}`
      if (policy.ruleFor(name) === 'latest') {
        return { ...result, warning: message }
      }

      changed = true
      return {
        ...result,
        target: undefined,
        updated: false,
        updateType: stepType(result.current, result.latest),
        reason: message,
      }
    })

    if (!changed) return current
  }
}

/**
 * A package moves in every manifest or none. The in-range commands are
 * workspace-wide, so a row held while its range allows newer (a cooldown,
 * a peer conflict, an override: holds that depend on the target) would move
 * anyway with its package's other rows. Those rows are held with it. An
 * exact pin (`wanted` equals `current`) has nothing to move and blocks
 * nothing.
 */
const holdTogether = (results: UpdateResult[]): UpdateResult[] => {
  const blocking = new Map<string, UpdateResult>()
  for (const r of results) {
    if (r.workspace === undefined || r.updated || blocking.has(r.name)) continue
    if (
      semver.valid(r.current) &&
      semver.valid(r.wanted) &&
      semver.gt(r.wanted, r.current)
    ) {
      blocking.set(r.name, r)
    }
  }
  if (blocking.size === 0) return results

  return results.map((r) => {
    const by = blocking.get(r.name)
    if (!by || !r.updated) return r
    const where = by.workspace === '.' ? 'the root' : by.workspace
    return {
      ...r,
      target: undefined,
      updated: false,
      updateType: stepType(r.current, r.latest),
      reason: `held with ${where} (${by.reason})`,
    }
  })
}

/**
 * Decides each outdated package's target (`updateChecker`: within the
 * manifest range by default, further only when the policy allows), then
 * applies the cooldown gate to that target. Network calls only happen for
 * packages with a target, and never when `cooldown` is 0 (the default).
 */
const filterPackages = async (
  outdatedPackages: Record<string, PackageInfo>,
  options: FilterPackagesOptions,
): Promise<UpdateResult[]> => {
  const {
    config,
    targetPackages,
    cwd = process.cwd(),
    registry,
    now,
    overrides: controlled = {},
  } = options
  const policy = policyFromConfig(config)
  const cooldownActive = isCooldownEnabled(config.cooldown)

  const initialResults: UpdateResult[] = expandWorkspaces(outdatedPackages).map(
    ({ name, workspace, info: packageInfo }) => {
      const { current, wanted, latest } = packageInfo
      const owner = workspace === undefined ? {} : { workspace }

      if (
        targetPackages &&
        targetPackages.length > 0 &&
        !targetPackages.includes(name)
      ) {
        return {
          name,
          ...owner,
          current,
          wanted,
          latest,
          updateType: stepType(current, latest),
          updated: false,
          reason: 'not targeted',
        }
      }

      const { target, reason } = updateChecker({ ...packageInfo, name }, policy)

      // The manager enforces an override whatever a rule says: a target
      // outside its range cannot take effect. (npm requires a direct
      // dependency's override to equal its own spec, so in-range targets pass.)
      // A held package names the override when latest is outside it too,
      // since that is what keeps it in place.
      const override = controlled[name]
      if (override && !semver.satisfies(target ?? latest, override.range)) {
        return {
          name,
          ...owner,
          current,
          wanted,
          latest,
          updateType: stepType(current, latest),
          updated: false,
          reason: `controlled by ${override.field} (${override.range})`,
        }
      }

      return {
        name,
        ...owner,
        current,
        wanted,
        latest,
        target,
        updateType: stepType(current, target ?? latest),
        updated: target !== undefined,
        reason,
      }
    },
  )

  const peers = initialResults.some((r) => r.updated)
    ? readInstalledPeers(cwd)
    : undefined

  // A peer hold can hold a package's other rows (holdTogether), and a row
  // held for any reason stops counting as moving for the peer check, so
  // both repeat until nothing changes. Each only ever holds, so this ends.
  const settle = (rows: UpdateResult[]): UpdateResult[] => {
    let current = rows
    for (;;) {
      const next = holdTogether(
        peers ? holdPeerConflicts(current, peers, policy) : current,
      )
      if (next.every((row, i) => row.updated === current[i].updated)) {
        return next
      }
      current = next
    }
  }

  const results = settle(initialResults)

  if (!cooldownActive) return results

  const gated = await Promise.all(
    results.map(async (result) => {
      if (!result.updated || !result.target) return result

      const releaseTimes = await registry.releaseTimes(result.name)
      const releaseTime = releaseTimes[result.target]
      const evaluation = evaluateCooldown(
        releaseTime,
        result.updateType,
        config.cooldown,
        now,
      )

      if (evaluation.gated) {
        return {
          ...result,
          target: undefined,
          updated: false,
          reason: `cooldown: released ${formatAgeDays(
            evaluation.ageDays,
          )} ago, requires ${evaluation.requiredDays}d`,
          releaseAge: evaluation.ageDays,
        }
      }

      return { ...result, releaseAge: evaluation.ageDays }
    }),
  )
  return settle(gated)
}

/**
 * Splits the updates the policy chose. `withinRange` packages go to the
 * manager by name, which installs the highest version the range allows.
 * `beyondRange` maps each package moving past its range to its new version,
 * which must be written into the manifest first. `manifests` is the same
 * split per manifest (root first, then by path), for the writes that belong
 * to one manifest; a single-package project has the root only.
 */
export const splitUpdates = (
  results: UpdateResult[],
): {
  names: string[]
  withinRange: string[]
  beyondRange: Record<string, string>
  manifests: ManifestPlan[]
} => {
  const names: string[] = []
  const withinRange: string[] = []
  const beyondRange: Record<string, string> = {}
  const byManifest = new Map<string, ManifestPlan>()

  for (const { name, workspace = '.', updated, target, wanted } of results) {
    if (!updated || !target) continue
    const inRange = target === wanted
    if (!names.includes(name)) names.push(name)
    if (inRange) {
      if (!withinRange.includes(name)) withinRange.push(name)
    } else beyondRange[name] = target

    let manifest = byManifest.get(workspace)
    if (!manifest) {
      manifest = { path: workspace, withinRange: [], beyondRange: {} }
      byManifest.set(workspace, manifest)
    }
    if (inRange) {
      if (!manifest.withinRange.includes(name)) manifest.withinRange.push(name)
    } else manifest.beyondRange[name] = target
  }

  const manifests = [...byManifest.values()].sort(byPath)
  return { names, withinRange, beyondRange, manifests }
}

export default filterPackages
