import fs from 'fs'
import path from 'path'
import semver from 'semver'
import type {
  AlwaysUpToDateConfig,
  CooldownConfig,
  ManifestPlan,
  PackageInfo,
  PinnedRow,
  Reason,
  UpdateResult,
  VersionManifest,
} from '@/types'
import {
  cooldownDaysFor,
  evaluateCooldown,
  isCooldownEnabled,
} from './cooldown'
import type { DeclaredDependency } from './dependencySpecs'
import { formatAgeDays } from './duration'
import { declaredNodeRange, enginesHold, runningNode } from './engines'
import {
  readInstalledManifests,
  readInstalledVersions,
  rowKey,
} from './installed'
import { sameLicense } from './license'
import logger from './logger'
import { fitRunningNode } from './nodeFit'
import type { ControllingOverride } from './overrides'
import { readInstalledPeers } from './peers'
import { targetPeerRows } from './plan/peerConflicts'
import { heldFor, stepType, withWarning } from './plan/rows'
import { createSettle } from './plan/settle'
import type { PlanRegistry } from './plan/types'
import {
  readTargetManifests,
  type TargetManifests,
  targetManifestOf,
} from './targetManifests'
import updateChecker, {
  policyFromConfig,
  type UpdatePolicy,
} from './updateChecker'
import { byPath, expandWorkspaces } from './workspaceRows'

// The tests and other callers import it from here.
export { withWarning }

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
  declared?: (row: {
    name: string
    workspace?: string
  }) => Pick<DeclaredDependency, 'name' | 'spec'> | undefined
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
 * The newest version between `current` and a target the cooldown held that
 * is past cooldown for its own step and not deprecated (#147), so a package
 * that publishes more often than the cooldown still moves. It is below the
 * target, so the policy allows a step no larger. Below `wanted` it must also
 * satisfy `range`, the one the manifest declares: `applyPinned` puts that
 * range back after the pin, and the manager keeps the version only if the
 * range allows it, which a range with a gap (`^1 || ^3`) need not (#151).
 * With no range known, nothing below `wanted` qualifies. A pre-release only
 * when the target is one.
 */
const cooledOffVersion = (
  { current, wanted, target }: UpdateResult,
  range: string | undefined,
  times: Record<string, string>,
  deprecated: Set<string>,
  cooldown: CooldownConfig | undefined,
  now: number | undefined,
): { version: string; ageDays: number | undefined } | undefined => {
  if (!target || !semver.valid(current) || !semver.valid(target)) {
    return undefined
  }
  const preRelease = semver.prerelease(target) !== null
  const candidates = Object.keys(times)
    .filter(
      (version) =>
        semver.valid(version) &&
        semver.gt(version, current) &&
        semver.lt(version, target) &&
        (preRelease || semver.prerelease(version) === null) &&
        !deprecated.has(version) &&
        // At `wanted` the manager installs it by name; past it, the spec is
        // rewritten to it.
        ((semver.valid(wanted) !== null && semver.gte(version, wanted)) ||
          (range !== undefined && semver.satisfies(version, range))),
    )
    .sort(semver.rcompare)
  for (const version of candidates) {
    const evaluation = evaluateCooldown(
      times[version],
      stepType(current, version),
      cooldown,
      now,
    )
    if (!evaluation.gated) return { version, ageDays: evaluation.ageDays }
  }
  return undefined
}

/** The most of a registry's message a report row shows. */
const MESSAGE_LIMIT = 400

/**
 * A registry's deprecation message on one line, as it lands in a terminal
 * row: line breaks, other control characters (an escape sequence's ESC among
 * them), zero-width and bidirectional formatting characters (which can make
 * a row read as something else) and runs of spaces become one space, and a
 * message past `MESSAGE_LIMIT` characters is cut with `…`.
 */
const oneLine = (text: string): string => {
  const line = text
    .replace(
      // biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
      /[\s\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]+/g,
      ' ',
    )
    .trim()
  return line.length > MESSAGE_LIMIT
    ? `${line.slice(0, MESSAGE_LIMIT).trimEnd()}…`
    : line
}

/**
 * Holds a moving row whose target the registry marks deprecated
 * (`deprecated: <message>`, #195); a `latest` rule moves it anyway, with the
 * message as a warning. When the installed version carries the same
 * deprecation, the move takes on nothing it doesn't have, so it goes ahead
 * with the warning: holding would keep an older deprecated version (every
 * next 14.0.x, for one). It judges the final target, so it runs after the cooldown, whose
 * fallbacks are never deprecated. It reads only the session's own lookups.
 */
const holdDeprecated = async (
  results: UpdateResult[],
  registry: FilterPackagesOptions['registry'],
  policy: UpdatePolicy,
  lookupName: (row: UpdateResult) => string,
): Promise<UpdateResult[]> => {
  const { lookedUp } = registry
  if (!lookedUp) return results
  return Promise.all(
    results.map(async (result) => {
      const { target, current } = result
      if (!result.updated || !target) return result
      const name = lookupName(result)
      const found = await lookedUp(name)
      if (!found) {
        logger.debug(
          `No lookup of ${name} in this session; its deprecation isn't checked`,
        )
        return result
      }
      if (!found.ok) return result
      const { versions } = found.package
      const deprecation = versions.find((v) => v.version === target)
      if (!deprecation?.deprecated) return result

      const message = oneLine(deprecation.deprecatedReason ?? '')
      const reason: Reason = {
        code: 'deprecated',
        message: `deprecated: ${message || 'no message given'}`,
      }
      // The installed version carries the same deprecation, so the move takes
      // on nothing new; a different message is a new reason, and holds.
      const installed = versions.find((v) => v.version === current)
      const sameAsInstalled =
        installed?.deprecated === true &&
        oneLine(installed.deprecatedReason ?? '') === message
      return sameAsInstalled || policy.ruleFor(result.name) === 'latest'
        ? withWarning(result, reason)
        : heldFor(result, reason)
    }),
  )
}

/** Characters of a license shown in a reason or warning; the rest is cut. */
const LICENSE_SHOWN = 40

/** A declared license (undefined: none) as a reason shows it: one line, cut. */
const shownLicense = (license: string | undefined): string => {
  const line = license === undefined ? '' : oneLine(license)
  if (line === '') return 'none'
  return line.length > LICENSE_SHOWN
    ? `${line.slice(0, LICENSE_SHOWN).trimEnd()}…`
    : line
}

/**
 * Holds a moving row whose target declares a different license from the
 * installed version (`license change: MIT → AGPL-3.0-or-later`, #197); a
 * `latest` rule moves it with the text as a warning. `none` stands for a
 * known manifest that declares no license, and a move to or from it is a
 * change too. Only the rows still moving are read: the current version's
 * license comes from `node_modules` when the installed copy is that version,
 * else from its own manifest (one request per name and version). A row
 * whose target manifest or current manifest is unknown moves unchecked, and
 * is returned in `unchecked` as `name@version`, the target's and the
 * installed version's apart, since a registry problem and a version the
 * registry no longer lists are fixed differently. Without a registry that
 * can read manifests, nothing is judged.
 */
const holdLicenseChanges = async (
  rows: UpdateResult[],
  manifests: TargetManifests,
  {
    registry,
    policy,
    lookupName,
    cwd,
  }: {
    registry: FilterPackagesOptions['registry']
    policy: UpdatePolicy
    lookupName: (row: UpdateResult) => string
    cwd: string
  },
): Promise<{
  rows: UpdateResult[]
  unchecked: { targets: string[]; installed: string[] }
}> => {
  const { versionManifest } = registry
  if (!versionManifest)
    return { rows, unchecked: { targets: [], installed: [] } }
  // A `missing` or non-semver current has no license to compare.
  const moving = rows.filter(
    (row) => row.updated && row.target && semver.valid(row.current),
  )
  const targets = new Set<string>()
  const installedUnknown = new Set<string>()
  const unchecked = () => ({
    targets: [...targets],
    installed: [...installedUnknown],
  })
  const judged = moving.filter((row) => {
    if (targetManifestOf(manifests, row, lookupName)) return true
    targets.add(`${lookupName(row)}@${row.target}`)
    return false
  })
  if (judged.length === 0) return { rows, unchecked: unchecked() }

  const installed = readInstalledManifests(cwd, judged)
  const read = new Map<string, Promise<VersionManifest | undefined>>()
  const currentOf = async (
    row: UpdateResult,
  ): Promise<{ known: boolean; license?: string }> => {
    const found = installed[rowKey(row)]
    if (found?.version === row.current) {
      return { known: true, license: found.license }
    }
    const name = lookupName(row)
    const key = `${name}@${row.current}`
    let pending = read.get(key)
    if (!pending) {
      pending = versionManifest(name, row.current)
      read.set(key, pending)
    }
    const manifest = await pending
    return manifest
      ? { known: true, license: manifest.license }
      : { known: false }
  }

  const held = new Map<UpdateResult, UpdateResult>()
  await Promise.all(
    judged.map(async (row) => {
      const target = targetManifestOf(manifests, row, lookupName)
      if (!target) return
      const current = await currentOf(row)
      if (!current.known) {
        installedUnknown.add(`${lookupName(row)}@${row.current}`)
        return
      }
      if (sameLicense(current.license, target.license)) return
      const reason: Reason = {
        code: 'license-change',
        message: `license change: ${shownLicense(current.license)} → ${shownLicense(target.license)}`,
      }
      held.set(
        row,
        policy.ruleFor(row.name) === 'latest'
          ? withWarning(row, reason)
          : heldFor(row, reason),
      )
    }),
  )
  return {
    rows: rows.map((row) => held.get(row) ?? row),
    unchecked: unchecked(),
  }
}

/**
 * A pass that judges each moving row by its target's own manifest (`engines.node`
 * today; license and peers are judged elsewhere): it holds or warns, never
 * moves a row. An unknown manifest (undefined) is a state each pass decides
 * for itself.
 */
type ManifestPass = (
  rows: UpdateResult[],
  context: {
    manifests: TargetManifests
    lookupName: (row: UpdateResult) => string
    policy: UpdatePolicy
  },
) => UpdateResult[]

/**
 * The `engines.node` a row's owning manifest declares (a member's own, else
 * the root's), read once per manifest; shared by the walk-back and the pass.
 */
const declaredEnginesReader = (
  cwd: string,
): ((row: UpdateResult) => string | undefined) => {
  const declaredIn = new Map<string, string | undefined>()
  const declaredAt = (dir: string): string | undefined => {
    if (!declaredIn.has(dir)) {
      const file = path.join(cwd, dir, 'package.json')
      let range: string | undefined
      try {
        const manifest: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
        const engines =
          typeof manifest === 'object' && manifest !== null
            ? (manifest as { engines?: unknown }).engines
            : undefined
        range = declaredNodeRange(
          typeof engines === 'object' && engines !== null
            ? (engines as { node?: unknown }).node
            : undefined,
          dir === '.' ? 'package.json' : `${dir}/package.json`,
        )
      } catch {
        range = undefined
      }
      declaredIn.set(dir, range)
    }
    return declaredIn.get(dir)
  }
  return (row) => {
    const owner = row.workspace ?? '.'
    return declaredAt(owner) ?? (owner === '.' ? undefined : declaredAt('.'))
  }
}

/**
 * Holds a moving row whose target's `engines.node` excludes the project's
 * Node (#199): the `engines.node` the row's manifest declares (a member's
 * own, else the root's) when there is one, else `node`. A `latest` rule moves
 * it with the text as a warning. A known document without `engines.node`
 * is no constraint; an unknown one is left to the caller's warning.
 */
const enginesPass = ({
  declaredOf,
  node,
  nodeLabel,
}: {
  declaredOf: (row: UpdateResult) => string | undefined
  node: string | null
  nodeLabel?: string
}): ManifestPass => {
  let noted = false
  return (rows, { manifests, lookupName, policy }) =>
    manifests.size === 0
      ? rows
      : rows.map((row) => {
          const range = targetManifestOf(
            manifests,
            row,
            lookupName,
          )?.enginesNode
          if (!range) return row
          const declared = declaredOf(row)
          if (declared === undefined && node === null) {
            if (!noted) {
              noted = true
              logger.debug(
                "No Node runs autd and the project declares no engines.node: engines aren't checked",
              )
            }
            return row
          }
          const message = enginesHold(range, {
            ...(declared === undefined ? {} : { declared }),
            running: node,
            ...(nodeLabel === undefined ? {} : { runningLabel: nodeLabel }),
          })
          if (!message) return row
          const reason: Reason = { code: 'engines', message }
          return policy.ruleFor(row.name) === 'latest'
            ? withWarning(row, reason)
            : heldFor(row, reason)
        })
}

/** Versions the registry marks deprecated, when the session can say. */
const deprecatedVersions = async (
  registry: FilterPackagesOptions['registry'],
  name: string,
): Promise<Set<string>> => {
  const lookup = await registry.lookup?.(name)
  return new Set(
    lookup?.ok
      ? lookup.package.versions
          .filter((v) => v.deprecated)
          .map((v) => v.version)
      : [],
  )
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
    ? readInstalledPeers(cwd)
    : undefined

  const settle = createSettle(peers, policy)

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
            ? async (row, version) => {
                const type = stepType(row.current, version)
                if (cooldownDaysFor(config.cooldown, type) <= 0) {
                  return { gated: false, ageDays: undefined }
                }
                const times = await registry.releaseTimes(lookupName(row), {
                  current: row.current,
                  target: row.target as string,
                })
                const { gated, ageDays } = evaluateCooldown(
                  times[version],
                  type,
                  config.cooldown,
                  now,
                )
                return { gated, ageDays }
              }
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
    const settled = settle(
      passed,
      manifests.size === 0
        ? undefined
        : {
            manifests,
            installed: peerRows.length > 0 ? readInstalled(peerRows) : {},
            lookupName,
          },
    )
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

  const gated = await Promise.all(
    results.map(async (result): Promise<UpdateResult> => {
      if (!result.updated || !result.target) return result
      // A zero-day step is never gated, whatever its release time is.
      if (cooldownDaysFor(config.cooldown, result.updateType) <= 0) {
        return { ...result, releaseAge: undefined }
      }

      const dependency = declared?.({
        name: result.name,
        workspace: result.workspace,
      })
      // A row is keyed by its manifest key; an alias's dates are its target's.
      const name = dependency?.name ?? result.name
      const releaseTimes = await registry.releaseTimes(name, {
        current: result.current,
        target: result.target,
      })
      const releaseTime = releaseTimes[result.target]
      const evaluation = evaluateCooldown(
        releaseTime,
        result.updateType,
        config.cooldown,
        now,
      )

      if (evaluation.gated) {
        const held = evaluation.unknown
          ? `release date unknown, requires ${evaluation.requiredDays}d`
          : `released ${formatAgeDays(
              evaluation.ageDays,
            )} ago, requires ${evaluation.requiredDays}d`
        const fallback = cooledOffVersion(
          result,
          dependency && 'range' in dependency.spec
            ? dependency.spec.range
            : undefined,
          releaseTimes,
          await deprecatedVersions(registry, name),
          config.cooldown,
          now,
        )
        if (fallback) {
          return {
            ...result,
            target: fallback.version,
            updateType: stepType(result.current, fallback.version),
            reason: {
              code: 'cooldown-fallback',
              message: `cooldown: ${result.target} ${held}`,
            },
            releaseAge: fallback.ageDays,
          }
        }
        return {
          ...result,
          target: undefined,
          judged: result.target,
          updated: false,
          reason: { code: 'cooldown', message: `cooldown: ${held}` },
          releaseAge: evaluation.ageDays,
        }
      }

      return { ...result, releaseAge: evaluation.ageDays }
    }),
  )
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
