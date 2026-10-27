import fs from 'fs'
import path from 'path'

import type { ManagerAdapter } from '@/managers/adapter'
import { packageJsonWorkspace, readManifest } from '@/managers/workspaces'
import {
  applyBerry,
  discoverBerry,
  installedBerry,
} from '@/managers/yarn/berry'
import {
  type RangedDependency,
  rewriteBerryLock,
  rewriteYarnV1Lock,
} from '@/managers/yarn/lockfile'
import { yarnNpmrcLayers } from '@/managers/yarn/npmrc'
import { yarnRegistryConfig } from '@/managers/yarn/yarnrc'
import { StepError } from '@/stepError'
import { logger } from '@/utils'
import { buildUpdateDescriptors, type DescriptorField } from '@/utils/files'
import { readInstalledVersions } from '@/utils/installed'
import { npmNpmrcLayers } from '@/utils/npmrcLoader'
import { manifestOverrides } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE, readTextFile, yamlValue } from '@/utils/saveStyle'

/**
 * Yarn 2+ ("berry") is identified by the `packageManager` field when it is
 * present, otherwise by a `.yarnrc.yml`, which yarn v1 does not use.
 */
export const isYarnBerry = (cwd: string): boolean => {
  const declared = /^yarn@(\d+)\./.exec(
    String(readManifest(cwd)?.packageManager ?? ''),
  )
  if (declared) return Number(declared[1]) >= 2

  return fs.existsSync(path.join(cwd, '.yarnrc.yml'))
}

/** The `yarn workspace <name> upgrade` flag that keeps each field's packages in it. */
const MEMBER_FIELD_FLAGS: [DescriptorField, string[]][] = [
  ['dependencies', []],
  ['devDependencies', ['-D']],
  ['optionalDependencies', ['-O']],
]

/** Whether the last `npmrcLayers` load for a directory took berry's path. */
const berryLoads = new Map<string, boolean>()

/** Rewrites the project's yarn.lock in place with one of the lockfile rewriters. */
const relockWith =
  (rewrite: (lock: string, pins: RangedDependency[]) => string) =>
  (cwd: string, pins: RangedDependency[]): void => {
    const file = path.join(cwd, 'yarn.lock')
    fs.writeFileSync(file, rewrite(fs.readFileSync(file, 'utf8'), pins), 'utf8')
  }

const yarn: ManagerAdapter = {
  name: 'yarn',
  lockfile: 'yarn.lock',

  readWorkspace: (cwd) => ({
    ...packageJsonWorkspace(cwd),
    catalogs: {},
  }),

  // berry reads .yarnrc.yml, which is not read yet (#107), and keeps npm's
  // .npmrc layers; v1 has its own layers and reads .yarnrc. `isYarnBerry`
  // looks at `cwd`'s own package.json, so a berry workspace member is taken
  // for v1 (#123). The choice is made once per load, in `npmrcLayers`, and
  // `registryConfig` follows it.
  npmrcLayers: (cwd, sources) => {
    const berry = isYarnBerry(cwd)
    berryLoads.set(cwd, berry)
    return berry ? npmNpmrcLayers(cwd, sources) : yarnNpmrcLayers(cwd, sources)
  },

  // yarn ignores an empty registry or scope route.
  emptyRegistry: { registry: false, scopes: false },

  registryConfig: (cwd, fromNpmrc, sources, npmrc) =>
    (berryLoads.get(cwd) ?? isYarnBerry(cwd))
      ? fromNpmrc
      : yarnRegistryConfig(cwd, fromNpmrc, sources, npmrc),

  ownDiscovery: (cwd) =>
    isYarnBerry(cwd)
      ? (run, { isWorkspace }) => discoverBerry(run, isWorkspace)
      : undefined,

  apply: async (
    run,
    cwd,
    { withinRange, beyondRange, manifests },
    { isWorkspace, manifests: members },
  ) => {
    // berry: autd writes the specs that move past their range, yarn locks.
    if (isYarnBerry(cwd)) {
      return applyBerry(
        run,
        cwd,
        { withinRange, manifests },
        yarn.saveStyle(cwd),
      )
    }

    // v1 rewrites the manifest itself and refuses to upgrade against a
    // pre-written package.json ("Outdated lockfile"). Hand it `name@spec`
    // descriptors instead: the current spec for in-range packages, the new
    // version with the entry's decorator for packages moving past it.
    const style = yarn.saveStyle(cwd)

    // No `--recursive`: v1 ignores it.
    if (!isWorkspace) {
      const { descriptors, notInManifest } = buildUpdateDescriptors(cwd, {
        withinRange,
        newVersions: beyondRange,
        style,
      })

      if (notInManifest.length > 0) {
        logger.warn(
          `Skipped ${notInManifest.join(', ')}: not listed in the root package.json.`,
        )
      }

      if (descriptors.length > 0) {
        await run(['upgrade', ...descriptors], { manifestWritten: false })
      }
      return
    }

    // v1 workspaces: `yarn upgrade` at the root only touches the root's
    // manifest, so each member with something moving gets its own
    // `yarn workspace <name> upgrade`, and yarn writes every manifest.
    let memberRan = false
    for (const m of manifests) {
      const { descriptors, byField, notInManifest } = buildUpdateDescriptors(
        path.join(cwd, m.path),
        { withinRange: m.withinRange, newVersions: m.beyondRange, style },
      )

      if (notInManifest.length > 0) {
        logger.warn(
          m.path === '.'
            ? `Skipped ${notInManifest.join(', ')}: not listed in the root package.json.`
            : `Skipped ${notInManifest.join(', ')}: not listed in ${m.path}/package.json.`,
        )
      }
      if (descriptors.length === 0) continue

      if (m.path === '.') {
        await run(['upgrade', ...descriptors], { manifestWritten: false })
        continue
      }

      const name = members.find((w) => w.path === m.path)?.name
      if (!name) {
        throw new StepError(
          'apply',
          `${m.path}/package.json has no name, so yarn cannot upgrade it as a workspace`,
        )
      }
      // `yarn workspace <name> upgrade` writes a devDependency into
      // `dependencies` as well unless told its field (1.22.22), so each
      // field gets its own command with that field's flag.
      for (const [field, flags] of MEMBER_FIELD_FLAGS) {
        if (byField[field].length === 0) continue
        await run(['workspace', name, 'upgrade', ...flags, ...byField[field]], {
          manifestWritten: false,
        })
      }
      memberRan = true
    }

    // A member's upgrade leaves node_modules unlinked until an install.
    if (memberRan) await run(['install'], { manifestWritten: false })
  },

  /**
   * berry locks versions in `yarn.lock` and, under PnP, has no node_modules,
   * so the versions come from `yarn info`. Yarn v1 reads node_modules.
   */
  installed: (run, cwd, rows) =>
    isYarnBerry(cwd)
      ? installedBerry(run, rows)
      : Promise.resolve(readInstalledVersions(cwd, rows)),

  /** berry: `defaultSemverRangePrefix` in .yarnrc.yml, where `''` means exact. Yarn v1 keeps the default. */
  saveStyle: (cwd) => {
    if (!isYarnBerry(cwd)) return DEFAULT_SAVE_STYLE
    const prefix = yamlValue(
      readTextFile(path.join(cwd, '.yarnrc.yml')),
      'defaultSemverRangePrefix',
    )
    if (prefix === undefined) return DEFAULT_SAVE_STYLE
    return { exact: prefix === '', prefix }
  },

  /**
   * `resolutions`, on berry only. Yarn v1 applies them to transitive
   * dependencies but not to a direct one (verified on 1.22.22: the direct
   * dependency still moved), so there is nothing to hold.
   */
  // Both yarns key yarn.lock by spec and resolve a restored range again
  // (yarn 1.22.22 and 4.12.0, 2026-10-27), so the pin is relocked first.
  pinning: (cwd) =>
    isYarnBerry(cwd)
      ? {
          install: ['install', '--no-immutable'],
          relock: relockWith(rewriteBerryLock),
        }
      : { install: ['install'], relock: relockWith(rewriteYarnV1Lock) },

  overrides: (cwd) =>
    isYarnBerry(cwd) ? manifestOverrides(cwd, ['resolutions']) : {},
}

export default yarn
