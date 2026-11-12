import semver from 'semver'
import type { UpdateResult } from '@/types'
import type { InstalledGraph } from '@/utils/installedGraph'
import type { PeerRequirement } from '@/utils/peers'
import { targetManifestOf } from '@/utils/targetManifests'
import type { UpdatePolicy } from '@/utils/updateChecker'
import { type KeptRules, keptInstalls } from './keptInstalls'
import {
  holdPeerConflicts,
  type Replaced,
  type StillInstalled,
  type TargetPeers,
  targetPeerConflict,
} from './peerConflicts'
import { heldFor, stepType, withWarning } from './rows'

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
      judged: r.target,
      updated: false,
      updateType: stepType(r.current, r.latest),
      reason: {
        code: 'held-with',
        message: `held with ${where} (${by.reason.message})`,
      },
    }
  })
}

/**
 * What the install's graph says once a set of rows moves, asked by both peer
 * checks: whether an installed package's peer ranges still count
 * (`stillInstalled`: those `keptInstalls` keeps, and any the graph doesn't
 * list), and whether an installed version the target-peer check would judge
 * a peer by goes with the packages the run moves (`replaced`). Before the
 * targets' manifests are read (no `targetPeers`), what a moving row depended
 * on is taken as replaced, so a hold that depends on it waits for the last
 * settle, which asks each target whether it still wants that version, and
 * holds then; a target with no manifest keeps it all. One walk per rows
 * array, which `settle` never mutates once handed out.
 */
const graphView = (
  graph: InstalledGraph,
  peers: Map<string, PeerRequirement[]>,
  targetPeers: TargetPeers | undefined,
): {
  stillInstalled: StillInstalled
  replaced: (rows: readonly UpdateResult[]) => Replaced
} => {
  const declared = new Set<string>()
  for (const [constrained, list] of peers) {
    for (const peer of list) {
      declared.add(`${peer.name}@${peer.version}\0${constrained}`)
    }
  }
  const rules: KeptRules = {
    isPeer: (parent, child) => declared.has(`${parent}\0${child}`),
    ...(targetPeers && {
      keeps: (row, child, version) => {
        const manifest = targetManifestOf(
          targetPeers.manifests,
          row,
          targetPeers.lookupName,
        )
        if (!manifest) return true
        const range =
          manifest.dependencies[child] ??
          manifest.optionalDependencies[child] ??
          manifest.peerDependencies[child]
        if (range === undefined) return false
        if (semver.validRange(range) === null) return true
        return semver.satisfies(version, range, { includePrerelease: true })
      },
    }),
  }
  const walks = new WeakMap<readonly UpdateResult[], Set<string>>()
  const kept = (rows: readonly UpdateResult[]): Set<string> => {
    let found = walks.get(rows)
    if (!found) {
      found = keptInstalls(rows, graph, rules)
      walks.set(rows, found)
    }
    return found
  }
  return {
    stillInstalled: (rows) => (peer) => {
      const id = `${peer.name}@${peer.version}`
      return !graph.dependencies.has(id) || kept(rows).has(id)
    },
    replaced: (rows) => (name, version) => {
      const id = `${name}@${version}`
      return graph.dependencies.has(id) && !kept(rows).has(id)
    },
  }
}

/**
 * The plan's `settle`, one per plan, so a debug note is logged once per plan.
 * A peer hold can hold a package's other rows (holdTogether), and a row
 * held for any reason stops counting as moving for the peer check, so
 * both repeat until nothing changes. Each only ever holds, so this ends.
 * With `targetPeers` (#198) a moving target's own peers are checked too,
 * after the installed ones; the last settle always passes them, so it is
 * the one that judges what a moving row's target still installs. A row
 * under a `latest` rule isn't held by them; it gets its warning once the
 * plan is stable, so a peer that stops moving leaves no stale "moving to".
 * Each pass makes a new array and none is mutated once handed out, which
 * `targetPeerConflict`'s row index needs.
 */
export const createSettle = (
  peers: Map<string, PeerRequirement[]> | undefined,
  policy: UpdatePolicy,
  graph?: InstalledGraph,
): ((rows: UpdateResult[], targetPeers?: TargetPeers) => UpdateResult[]) => {
  const noted = new Set<string>()
  const settle = (
    rows: UpdateResult[],
    targetPeers?: TargetPeers,
  ): UpdateResult[] => {
    const view =
      peers && graph ? graphView(graph, peers, targetPeers) : undefined
    let current = rows
    for (;;) {
      const peered = peers
        ? holdPeerConflicts(current, peers, policy, view?.stillInstalled)
        : current
      const checked = targetPeers
        ? peered.map((row) => {
            if (policy.ruleFor(row.name) === 'latest') return row
            const conflict = targetPeerConflict(
              row,
              peered,
              targetPeers,
              noted,
              view?.replaced(peered),
            )
            return conflict ? heldFor(row, conflict) : row
          })
        : peered
      const next = holdTogether(checked)
      if (next.every((row, i) => row.updated === current[i].updated)) {
        if (!targetPeers) return next
        return next.map((row) => {
          if (policy.ruleFor(row.name) !== 'latest') return row
          const conflict = targetPeerConflict(
            row,
            next,
            targetPeers,
            noted,
            view?.replaced(next),
          )
          return conflict ? withWarning(row, conflict) : row
        })
      }
      current = next
    }
  }
  return settle
}
