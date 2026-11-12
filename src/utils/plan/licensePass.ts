import semver from 'semver'
import type { Reason, UpdateResult, VersionManifest } from '@/types'
import { readInstalledManifests, rowKey } from '@/utils/installed'
import { sameLicense } from '@/utils/license'
import { type TargetManifests, targetManifestOf } from '@/utils/targetManifests'
import type { UpdatePolicy } from '@/utils/updateChecker'
import { oneLine } from './deprecationPass'
import { heldFor, withWarning } from './rows'
import type { PlanRegistry } from './types'

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
export const holdLicenseChanges = async (
  rows: UpdateResult[],
  manifests: TargetManifests,
  {
    registry,
    policy,
    lookupName,
    cwd,
  }: {
    registry: PlanRegistry
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
