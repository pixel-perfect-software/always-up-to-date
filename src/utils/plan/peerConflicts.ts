import semver from 'semver'
import type { Reason, UpdateResult } from '@/types'
import { rowKey } from '@/utils/installed'
import logger from '@/utils/logger'
import type { PeerRequirement } from '@/utils/peers'
import { type TargetManifests, targetManifestOf } from '@/utils/targetManifests'
import type { UpdatePolicy } from '@/utils/updateChecker'
import { heldFor, withWarning } from './rows'

/**
 * Whether an installed package's peer ranges still count once `rows` move:
 * false for one the run replaces (`keptInstalls`). Absent, every one counts.
 */
export type StillInstalled = (
  rows: UpdateResult[],
) => (peer: PeerRequirement) => boolean

/**
 * Whether an installed `name@version` goes with the packages the run moves,
 * so it says nothing about what will be installed (`keptInstalls`).
 */
export type Replaced = (name: string, version: string) => boolean

/**
 * Holds targets an installed package's peer range excludes. A range declared
 * by a package that is itself moving in this run doesn't count here: those
 * are the new version's peers, which `targetPeerConflict` checks from the
 * version document (#198). Nor does one declared by a package the run
 * replaces (`stillInstalled`): one installed only for packages that move,
 * such as a tiptap extension `@tiptap/starter-kit` pins, whose exact peer
 * on the old `@tiptap/core` would otherwise hold core forever. Holding one
 * package can expose a conflict for another, so this repeats until nothing
 * changes. A `latest` rule still moves, with the conflict as a warning.
 */
export const holdPeerConflicts = (
  results: UpdateResult[],
  peers: Map<string, PeerRequirement[]>,
  policy: UpdatePolicy,
  stillInstalled?: StillInstalled,
): UpdateResult[] => {
  let current = results
  for (;;) {
    const moving = new Set(current.filter((r) => r.updated).map((r) => r.name))
    const counts = stillInstalled?.(current)
    let changed = false

    current = current.map((result) => {
      const { name, target } = result
      if (!result.updated || !target) return result

      const conflict = (peers.get(name) ?? []).find(
        (peer) =>
          !moving.has(peer.name) &&
          !semver.satisfies(target, peer.range, { includePrerelease: true }) &&
          (counts?.(peer) ?? true),
      )
      if (!conflict) return result

      const reason: Reason = {
        code: 'peer-conflict',
        message: `peer conflict: ${conflict.name}@${conflict.version} needs ${name} ${conflict.range}`,
      }
      if (policy.ruleFor(name) === 'latest') return withWarning(result, reason)

      changed = true
      return heldFor(result, reason)
    })

    if (!changed) return current
  }
}

/**
 * Every peer a moving target needs, once per (peer, manifest): the plan's own
 * rows answer for most, the installed copies (read for these) for the rest.
 * No manifests read (a session that can't): nothing to check.
 */
export const targetPeerRows = (
  rows: UpdateResult[],
  manifests: TargetManifests,
  lookupName: (row: UpdateResult) => string,
): { name: string; workspace?: string }[] =>
  manifests.size === 0
    ? []
    : [
        ...new Map(
          rows.flatMap((row) => {
            const manifest = targetManifestOf(manifests, row, lookupName)
            return manifest
              ? Object.keys(manifest.peerDependencies).map((name) => {
                  const peer = {
                    name,
                    ...(row.workspace === undefined
                      ? {}
                      : { workspace: row.workspace }),
                  }
                  return [rowKey(peer), peer] as const
                })
              : []
          }),
        ).values(),
      ]

/** What `targetPeerConflict` judges a target's peers against. */
export interface TargetPeers {
  manifests: TargetManifests
  /** Installed versions of the peers, by `rowKey`. */
  installed: Record<string, string>
  lookupName: (row: UpdateResult) => string
}

// Built once per array: `settle` makes a new array each pass and never
// mutates one it has handed out, so an index can't go stale.
const rowIndexes = new WeakMap<
  readonly UpdateResult[],
  Map<string, UpdateResult>
>()

/** `rows` by workspace and name, the first of a pair winning as `find` would. */
const indexOf = (rows: readonly UpdateResult[]): Map<string, UpdateResult> => {
  let index = rowIndexes.get(rows)
  if (!index) {
    index = new Map()
    for (const r of rows) {
      const key = `${r.workspace ?? '.'}\0${r.name}`
      if (!index.has(key)) index.set(key, r)
    }
    rowIndexes.set(rows, index)
  }
  return index
}

/**
 * The first peer of a moving row's target (its own version document, #198)
 * that the plan leaves outside the declared range, worded as the reason:
 * `peer conflict: react-redux@9.2.0 needs react ^18.0 || ^19 (installed
 * 17.0.2)`. The version a peer is left at is its row's target when that row
 * moves, else its current version, else (no row) the installed one. From a
 * workspace member, the member's row comes first, then the root's, as the
 * manager hoists a peer to the root; which of the two a member resolves is
 * a guess. A peer that isn't installed is fine: optional, or (with a debug
 * line, once) left to the manager, which installs it; an installed optional
 * peer must satisfy its range. An installed copy the run replaces
 * (`replaced`, from the install's graph) is left to the manager too. A range `semver` can't read (`workspace:*`)
 * isn't checked.
 */
export const targetPeerConflict = (
  row: UpdateResult,
  rows: readonly UpdateResult[],
  { manifests, installed, lookupName }: TargetPeers,
  noted: Set<string>,
  replaced?: Replaced,
): Reason | undefined => {
  const { target } = row
  if (!row.updated || !target || manifests.size === 0) return undefined
  const manifest = targetManifestOf(manifests, row, lookupName)
  if (!manifest) return undefined
  const name = lookupName(row)
  const workspace = row.workspace ?? '.'
  const note = (message: string) => {
    if (noted.has(message)) return
    noted.add(message)
    logger.debug(message)
  }

  const plannedFor = (
    peer: string,
    where: string,
  ): { version: string; moving: boolean } | undefined => {
    const found = indexOf(rows).get(`${where}\0${peer}`)
    if (!found) return undefined
    if (found.updated && found.target) {
      return { version: found.target, moving: true }
    }
    return found.current === 'missing'
      ? undefined
      : { version: found.current, moving: false }
  }

  for (const [peer, range] of Object.entries(manifest.peerDependencies)) {
    if (peer === name) continue
    if (semver.validRange(range) === null) {
      note(
        `peer ${peer} ${range} of ${name}@${target} is not a semver range; not checked`,
      )
      continue
    }
    const planned =
      plannedFor(peer, workspace) ??
      (workspace === '.' ? undefined : plannedFor(peer, '.'))
    const found = planned
      ? undefined
      : installed[rowKey({ name: peer, workspace: row.workspace })]
    // A hoisted copy the run replaces (an extension `@tiptap/starter-kit`
    // pins, under npm, yarn or bun) is not what the peer resolves to after it.
    if (found !== undefined && replaced?.(peer, found)) {
      note(
        `${name}@${target} needs ${peer} ${range}; the installed ${found} goes with the packages this run moves, so it is left to the manager`,
      )
      continue
    }
    const version = planned?.version ?? found
    if (version === undefined) {
      if (!manifest.optionalPeers.includes(peer)) {
        note(
          `${name}@${target} needs ${peer} ${range}, which isn't installed; left to the manager`,
        )
      }
      continue
    }
    if (semver.valid(version) === null) continue
    if (semver.satisfies(version, range, { includePrerelease: true })) continue
    return {
      code: 'target-peers',
      message: `peer conflict: ${name}@${target} needs ${peer} ${range} (${planned?.moving ? 'moving to' : 'installed'} ${version})`,
    }
  }
  return undefined
}
