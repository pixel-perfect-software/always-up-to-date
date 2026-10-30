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
import { buildUpdateDescriptors, updatePackageJson } from '@/utils/files'
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
    // `yarn workspace <name> upgrade`, one command carrying every field's
    // descriptors.
    //
    // `-D` and `-O` are not `upgrade` options in yarn 1.22.22: commander
    // takes the next descriptor as the flag's value and upgrades everything,
    // so a field cannot be named. Without one, yarn copies a devDependency
    // into `dependencies` (and an optionalDependency likewise). So after each
    // command the manifest's original bytes go back, then its beyond-range
    // specs are written as `nextVersionSpec` made them for the descriptors,
    // and one `install` makes node_modules and yarn.lock agree with the
    // restored manifests. Checked on yarn 1.22.22, 2026-10-29: `-O` is
    // swallowed like `-D` (p1-opt: every dependency upgraded, `ms` added to
    // the member's dependencies); the root's `upgrade` does not copy a root
    // devDependency into `dependencies` (p1-rootdev), so there the restore
    // changes nothing and only the beyond-range write matters.
    let installNeeded = false
    let written = false
    for (const m of manifests) {
      const dir = path.join(cwd, m.path)
      const { descriptors, notInManifest } = buildUpdateDescriptors(dir, {
        withinRange: m.withinRange,
        newVersions: m.beyondRange,
        style,
      })

      if (notInManifest.length > 0) {
        logger.warn(
          m.path === '.'
            ? `Skipped ${notInManifest.join(', ')}: not listed in the root package.json.`
            : `Skipped ${notInManifest.join(', ')}: not listed in ${m.path}/package.json.`,
        )
      }
      if (descriptors.length === 0) continue

      let command: string[]
      if (m.path === '.') {
        command = ['upgrade', ...descriptors]
      } else {
        const name = members.find((w) => w.path === m.path)?.name
        if (!name) {
          throw new StepError(
            'apply',
            `${m.path}/package.json has no name, so yarn cannot upgrade it as a workspace`,
          )
        }
        command = ['workspace', name, 'upgrade', ...descriptors]
        installNeeded = true
      }

      const file = path.join(dir, 'package.json')
      const original = fs.readFileSync(file, 'utf8')
      await run(command, { manifestWritten: written })
      if (fs.readFileSync(file, 'utf8') !== original) {
        fs.writeFileSync(file, original, 'utf8')
        installNeeded = true
      }
      if (Object.keys(m.beyondRange).length > 0) {
        await updatePackageJson(dir, m.beyondRange, style)
        written = true
      }
    }

    // `--check-files`: a member's `upgrade` leaves the member's other
    // dependencies out of node_modules (1.22.22: commander and debug gone
    // after `workspace @autd/b upgrade commander debug kleur`), yet records
    // the integrity of the manifests, so a plain `install` says "Already
    // up-to-date" and leaves them out. `--check-files` relinks them and
    // leaves yarn.lock alone (p1-root, 2026-10-29).
    if (installNeeded) {
      await run(['install', '--check-files'], { manifestWritten: written })
    }
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
