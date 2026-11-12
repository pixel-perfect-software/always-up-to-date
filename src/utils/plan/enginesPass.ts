import fs from 'fs'
import path from 'path'
import type { Reason, UpdateResult } from '@/types'
import { declaredNodeRange, enginesHold } from '@/utils/engines'
import logger from '@/utils/logger'
import { targetManifestOf } from '@/utils/targetManifests'
import { heldFor, withWarning } from './rows'
import type { ManifestPass } from './types'

/**
 * The `engines.node` a row's owning manifest declares (a member's own, else
 * the root's), read once per manifest; shared by the walk-back and the pass.
 */
export const declaredEnginesReader = (
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
export const enginesPass = ({
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
