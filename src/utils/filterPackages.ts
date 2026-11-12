import semver from 'semver'
import type {
  AlwaysUpToDateConfig,
  ManifestPlan,
  PackageInfo,
  PinnedRow,
  UpdateResult,
} from '@/types'
import { isCooldownEnabled } from './cooldown'
import { runningNode } from './engines'
import { readInstalledVersions } from './installed'
import { type InstalledGraph, readInstalledGraph } from './installedGraph'
import logger from './logger'
import type { ControllingOverride } from './overrides'
import { type PeerRequirement, readInstalledPeers } from './peers'
import { holdCooldown, versionCooldown } from './plan/cooldownPass'
import { holdDeprecated } from './plan/deprecationPass'
import { declaredEnginesReader, enginesPass } from './plan/enginesPass'
import { holdLicenseChanges } from './plan/licensePass'
import { fitRunningNode } from './plan/nodeFit'
import { targetPeerRows } from './plan/peerConflicts'
import { stepType } from './plan/rows'
import { createSettle } from './plan/settle'
import type { DeclaredOf, ManifestPass, PlanRegistry } from './plan/types'
import { readTargetManifests } from './targetManifests'
import updateChecker, { policyFromConfig } from './updateChecker'
import { byPath, expandWorkspaces } from './workspaceRows'

interface FilterPackagesOptions {
  config: AlwaysUpToDateConfig
  targetPackages?: string[]
  cwd?: string
  /**
   * Where the cooldown gate reads publish times and (`lookup`, when given)
   * which versions are deprecated; only asked when cooldown is on. A moving
   * row's target is checked for deprecation (#195) in `lookedUp`, the
   * session's own lookups, which never sends a request; without it, or for a
   * name the session never looked up, nothing is held as deprecated. Each
   * target still moving after that has its own manifest read
   * (`versionManifest`, #196); without it, none is.
   */
  registry: PlanRegistry
  now?: number
  /** Packages pinned by an override the manager enforces; without it no package is held for one. */
  overrides?: Record<string, ControllingOverride>
  /**
   * What a row's manifest declares for it, by manifest key; asked for each
   * target the cooldown checks. Its `name` is what the gate looks up, an
   * alias's target (#152); its range is what a fallback below `wanted` must
   * satisfy (#151). Without it, the row's own name is looked up and no
   * fallback lands below `wanted`.
   */
  declared?: DeclaredOf
  /**
   * The installed version of each package a moving target needs as a peer
   * (#198), by `rowKey`, asked once per plan with a `{ name, workspace }` for
   * every (peer, manifest) pair. Any installed package counts, declared or
   * not (peers are often hoisted). Default: `node_modules`; the pipeline
   * passes the lockfile's reader where the manager's lockfile stands in for it.
   */
  installed?: (
    rows: { name: string; workspace?: string }[],
  ) => Record<string, string>
  /**
   * Installed packages' peer ranges, keyed by the package they constrain,
   * for the peer pass; read once, only when something moves. Default:
   * `readInstalledPeers(cwd)` (node_modules); the pipeline passes the
   * lockfile's reader where the manager's lockfile stands in for it (#232).
   */
  installedPeers?: () => Map<string, PeerRequirement[]>
  /**
   * What is installed and what installed it, for the peer pass to tell a
   * package the run replaces from one that stays; read with the peers.
   * Default: `readInstalledGraph(cwd)` (pnpm's `.pnpm/lock.yaml`); without
   * one, every installed peer range counts.
   */
  installedGraph?: () => InstalledGraph | undefined
  /**
   * The Node a target's `engines.node` is judged against when the project
   * declares none (#199): default `runningNode()`; null when there is none
   * (a Bun runtime), and then nothing is checked without a declaration.
   */
  node?: string | null
  /** What `node` is called in a reason (`pnpm nodeVersion`); default `running node`. */
  nodeLabel?: string
  /**
   * The manager installs a version its Node runs over a newer one whose
   * `engines.node` excludes it (`ManagerAdapter.skipsEnginesExcluded`, npm,
   * #200): an in-range row whose target needs another Node moves to the
   * newest version below it that fits (`fitRunningNode`). Default false.
   */
  skipsEnginesExcluded?: boolean
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
    declared,
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
          reason: { code: 'not-targeted', message: 'not targeted' },
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
          ...(target === undefined ? {} : { judged: target }),
          updated: false,
          reason: {
            code: 'override',
            message: `controlled by ${override.field} (${override.range})`,
          },
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
    ? (options.installedPeers?.() ?? readInstalledPeers(cwd))
    : undefined

  const graph = peers
    ? (options.installedGraph ?? (() => readInstalledGraph(cwd)))()
    : undefined

  const settle = createSettle(peers, policy, graph)

  const results = settle(initialResults)

  // A row is keyed by its manifest key; an alias's versions are its target's.
  const lookupName = (row: UpdateResult): string =>
    declared?.({ name: row.name, workspace: row.workspace })?.name ?? row.name

  // Every pass below judges the final target, so it runs after the cooldown,
  // and a hold there is settled again. The deprecation pass reads only what
  // discovery looked up; the manifests (#196) are read for the rows still
  // moving once it has settled, so a held row costs no request.
  const signals = async (rows: UpdateResult[]) => {
    const moving = settle(
      await holdDeprecated(rows, registry, policy, lookupName),
    )
    const read = await readTargetManifests(moving, {
      registry,
      lookupName,
    })
    const node = options.node === undefined ? runningNode() : options.node
    const declaredOf = declaredEnginesReader(cwd)
    // npm installs the newest version its Node runs (#200): retarget a row
    // whose target it would skip, before the passes below judge the target.
    const { rows: fitted, manifests } = options.skipsEnginesExcluded
      ? await fitRunningNode(moving, {
          node,
          manifests: read,
          registry,
          lookupName,
          declaredOf,
          rangeOf: (row) => {
            const spec = declared?.({
              name: row.name,
              workspace: row.workspace,
            })?.spec
            return spec && 'range' in spec ? spec.range : undefined
          },
          cooldownOf: cooldownActive
            ? versionCooldown({
                cooldown: config.cooldown,
                registry,
                lookupName,
                now,
              })
            : undefined,
        })
      : { rows: moving, manifests: read }
    const licensed = await holdLicenseChanges(fitted, manifests, {
      registry,
      policy,
      lookupName,
      cwd,
    })
    const passes: readonly ManifestPass[] = [
      enginesPass({
        declaredOf,
        node,
        nodeLabel: options.nodeLabel,
      }),
    ]
    const passed = passes.reduce(
      (current, pass) => pass(current, { manifests, lookupName, policy }),
      licensed.rows,
    )
    const peerRows = targetPeerRows(passed, manifests, lookupName)
    const readInstalled =
      options.installed ??
      ((asked) => readInstalledVersions(cwd, asked, { declaredOnly: false }))
    // Always passed, manifests or not: the last settle is the one that asks
    // each target what it still installs (with none read, it keeps them all).
    const settled = settle(passed, {
      manifests,
      installed: peerRows.length > 0 ? readInstalled(peerRows) : {},
      lookupName,
    })
    const listed = (keys: string[]): string =>
      `${keys.slice(0, 10).join(', ')}${keys.length > 10 ? ` and ${keys.length - 10} more` : ''}`
    const { targets, installed } = licensed.unchecked
    const missing = [
      targets.length > 0 ? `target ${listed(targets)}` : undefined,
      installed.length > 0 ? `installed ${listed(installed)}` : undefined,
    ].filter(Boolean)
    if (missing.length > 0) {
      logger.warn(
        `No version manifest for ${missing.join('; ')}: they move without license, peer or engines checks`,
      )
    }
    return settled
  }

  if (!cooldownActive) return signals(results)

  const gated = await holdCooldown(results, {
    cooldown: config.cooldown,
    registry,
    declared,
    now,
  })
  return signals(settle(gated))
}

/**
 * Packages with a cooldown fallback (#147): a moving row whose target is
 * neither `wanted` nor `latest`. `splitUpdates` pins every moving row of
 * them, and `checkApplied` wants each installed at exactly its target.
 */
export const pinnedPackages = (results: UpdateResult[]): Set<string> =>
  new Set(
    results
      .filter(
        (r) =>
          r.updated &&
          r.target &&
          r.target !== r.wanted &&
          r.target !== r.latest,
      )
      .map((r) => r.name),
  )

/**
 * Splits the updates the policy chose. `withinRange` packages go to the
 * manager by name, which installs the highest version the range allows.
 * `beyondRange` maps each package moving past its range to its new version,
 * which must be written into the manifest first. `manifests` is the same
 * split per manifest (root first, then by path), for the writes that belong
 * to one manifest; a single-package project has the root only. `pinned` are
 * the rows moving below the version their manager would pick (`wanted`, or
 * `latest` past the range): cooldown fallbacks (#147), which `applyPinned`
 * moves first. Every moving row of a package with one pinned row is pinned,
 * since the in-range commands are workspace-wide; `names` leaves them out.
 * With `pinMembers` (yarn v1, #127), a package moving in a workspace member is
 * pinned too, so the move resolves with a root install.
 */
export const splitUpdates = (
  results: UpdateResult[],
  { pinMembers = false }: { pinMembers?: boolean } = {},
): {
  names: string[]
  withinRange: string[]
  beyondRange: Record<string, string>
  manifests: ManifestPlan[]
  pinned: PinnedRow[]
} => {
  const names: string[] = []
  const withinRange: string[] = []
  const beyondRange: Record<string, string> = {}
  const byManifest = new Map<string, ManifestPlan>()
  const pinned: PinnedRow[] = []

  const pinnedNames = pinnedPackages(results)
  if (pinMembers) {
    for (const { name, workspace = '.', updated, target } of results) {
      if (updated && target && workspace !== '.') pinnedNames.add(name)
    }
  }

  for (const { name, workspace = '.', updated, target, wanted } of results) {
    if (!updated || !target) continue
    if (pinnedNames.has(name)) {
      pinned.push({
        path: workspace,
        name,
        version: target,
        beyondRange:
          semver.valid(target) !== null &&
          semver.valid(wanted) !== null &&
          semver.gt(target, wanted),
      })
      continue
    }
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
  return { names, withinRange, beyondRange, manifests, pinned }
}

export default filterPackages
