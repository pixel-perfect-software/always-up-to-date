import semver from 'semver'
import type { UpdateResult } from '@/types'
import type { PeerRequirement } from '@/utils/peers'
import type { UpdatePolicy } from '@/utils/updateChecker'
import {
  holdPeerConflicts,
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
 * The plan's `settle`, one per plan, so a debug note is logged once per plan.
 * A peer hold can hold a package's other rows (holdTogether), and a row
 * held for any reason stops counting as moving for the peer check, so
 * both repeat until nothing changes. Each only ever holds, so this ends.
 * With `targetPeers` (#198) a moving target's own peers are checked too,
 * after the installed ones. A row under a `latest` rule isn't held by
 * them; it gets its warning once the plan is stable, so a peer that stops
 * moving leaves no stale "moving to". Each pass makes a new array and none
 * is mutated once handed out, which `targetPeerConflict`'s row index needs.
 */
export const createSettle = (
  peers: Map<string, PeerRequirement[]> | undefined,
  policy: UpdatePolicy,
): ((rows: UpdateResult[], targetPeers?: TargetPeers) => UpdateResult[]) => {
  const noted = new Set<string>()
  const settle = (
    rows: UpdateResult[],
    targetPeers?: TargetPeers,
  ): UpdateResult[] => {
    let current = rows
    for (;;) {
      const peered = peers ? holdPeerConflicts(current, peers, policy) : current
      const checked = targetPeers
        ? peered.map((row) => {
            if (policy.ruleFor(row.name) === 'latest') return row
            const conflict = targetPeerConflict(row, peered, targetPeers, noted)
            return conflict ? heldFor(row, conflict) : row
          })
        : peered
      const next = holdTogether(checked)
      if (next.every((row, i) => row.updated === current[i].updated)) {
        if (!targetPeers) return next
        return next.map((row) => {
          if (policy.ruleFor(row.name) !== 'latest') return row
          const conflict = targetPeerConflict(row, next, targetPeers, noted)
          return conflict ? withWarning(row, conflict) : row
        })
      }
      current = next
    }
  }
  return settle
}
