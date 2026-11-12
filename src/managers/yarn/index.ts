import fs from 'fs'
import path from 'path'

import type { ManagerAdapter } from '@/managers/adapter'
import {
  packageJsonWorkspace,
  packageJsonWorkspaceRoot,
  readManifest,
} from '@/managers/workspaces'
import {
  applyBerry,
  berryProjectRoot,
  readBerryLock,
  yarnProjectDir,
} from '@/managers/yarn/berry'
import {
  type RangedDependency,
  rewriteBerryLock,
  rewriteYarnV1Lock,
} from '@/managers/yarn/lockfile'
import { yarnNpmrcLayers } from '@/managers/yarn/npmrc'
import { yarnRegistryConfig } from '@/managers/yarn/yarnrc'
import { berryRegistryConfig } from '@/managers/yarn/yarnrcYml'
import { StepError } from '@/stepError'
import { ancestorDirs } from '@/utils/ancestors'
import { readInstalledVersions } from '@/utils/installed'
import logger from '@/utils/logger'
import { manifestOverrides } from '@/utils/overrides'
import { DEFAULT_SAVE_STYLE, readTextFile, yamlValue } from '@/utils/saveStyle'
import { buildUpdateDescriptors } from '@/utils/versionSpecs'

/**
 * Yarn 2+ ("berry") for the project `dir` belongs to, the same from the root,
 * a member or a directory inside one. Walking from `dir` up to the yarn
 * project's root, the first package.json with a `packageManager` that names
 * yarn decides (Corepack: the nearest field wins); otherwise a `.yarnrc.yml`
 * on the way means berry, which yarn v1 does not use.
 */
export const isYarnBerry = (dir: string): boolean => {
  const walk = ancestorDirs(dir, yarnProjectDir(dir))
  for (const at of walk) {
    const declared = /^yarn@(\d+)\./.exec(
      String(readManifest(at)?.packageManager ?? ''),
    )
    if (declared) return Number(declared[1]) >= 2
  }
  return walk.some((at) => fs.existsSync(path.join(at, '.yarnrc.yml')))
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

  projectRoot: (dir) =>
    isYarnBerry(dir) ? berryProjectRoot(dir) : packageJsonWorkspaceRoot(dir),

  readWorkspace: (cwd) => ({
    ...packageJsonWorkspace(cwd),
    catalogs: {},
  }),

  // berry reads no .npmrc (#107, r19): its registries come from .yarnrc.yml
  // (`berryRegistryConfig`); v1 has its own .npmrc layers and reads .yarnrc. `isYarnBerry`
  // answers for the whole project, so a berry member gets berry's layers too.
  // The choice is made once per load, in `npmrcLayers`, and `registryConfig`
  // follows it.
  npmrcLayers: (cwd, sources) => {
    const berry = isYarnBerry(cwd)
    berryLoads.set(cwd, berry)
    return berry ? [] : yarnNpmrcLayers(cwd, sources)
  },

  // yarn ignores an empty registry or scope route.
  emptyRegistry: { registry: false, scopes: false },

  registryConfig: (cwd, fromNpmrc, sources, npmrc) =>
    (berryLoads.get(cwd) ?? isYarnBerry(cwd))
      ? berryRegistryConfig(cwd, sources)
      : yarnRegistryConfig(cwd, fromNpmrc, sources, npmrc),

  // berry (#107): `yarn.lock` holds the installed versions, PnP or not; v1
  // reads node_modules.
  installedFromLockfile: (cwd) =>
    isYarnBerry(cwd) ? { file: 'yarn.lock', read: readBerryLock } : undefined,

  // berry resolves a range to its highest version, with no preference for
  // the `latest` tag (yarn 4.18.1, p-latest); v1 prefers `latest`.
  prefersLatestInRange: (cwd) => !isYarnBerry(cwd),

  apply: async (run, cwd, { withinRange, beyondRange, manifests }) => {
    // berry: autd writes the specs that move past their range, yarn locks.
    if (isYarnBerry(cwd)) {
      return applyBerry(
        run,
        cwd,
        { withinRange, manifests },
        yarn.saveStyle(cwd),
      )
    }

    // v1 moves the root's own rows only: a workspace member's are pinned by
    // the pipeline (`pinMembers`) and resolve with a root install. yarn's one
    // per-member command, `workspace <name> upgrade`, resolves with the
    // member directory's registry settings, where `~/.npmrc` outranks the
    // root's `.npmrc` (#127; yarn 1.22.22, 2026-11-03, m1-m4), so it could
    // install from a registry discovery never asked.
    const members = manifests.filter((m) => m.path !== '.')
    if (members.length > 0) {
      throw new StepError(
        'apply',
        `yarn v1 moves a workspace member's packages with a root install, but ${members.map((m) => m.path).join(', ')} reached \`yarn upgrade\``,
      )
    }

    // v1 rewrites the manifest itself and refuses to upgrade against a
    // pre-written package.json ("Outdated lockfile"). Hand it `name@spec`
    // descriptors instead: the current spec for in-range packages, the new
    // version with the entry's decorator for packages moving past it. At a
    // workspace root, `upgrade` touches the root's manifest only and copies
    // nothing between its fields (p1-rootdev). No `--recursive`: v1 ignores it.
    const { descriptors, notInManifest } = buildUpdateDescriptors(cwd, {
      withinRange,
      newVersions: beyondRange,
      style: yarn.saveStyle(cwd),
    })

    if (notInManifest.length > 0) {
      logger.warn(
        `Skipped ${notInManifest.join(', ')}: not listed in the root package.json.`,
      )
    }

    if (descriptors.length > 0) {
      await run(['upgrade', ...descriptors], { manifestWritten: false })
    }
  },

  /**
   * berry locks versions in `yarn.lock` and, under PnP, has no node_modules,
   * so the versions after apply come from `yarn.lock`. Yarn v1 reads
   * node_modules.
   */
  installed: (_run, cwd, rows) => {
    if (!isYarnBerry(cwd))
      return Promise.resolve(readInstalledVersions(cwd, rows))
    const versions: Record<string, string> = {}
    for (const [key, { version, linked }] of Object.entries(
      readBerryLock(cwd, rows),
    )) {
      if (!linked) versions[key] = version
    }
    return Promise.resolve(versions)
  },

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

  // v1: a member's move resolves with a root install (see `apply`); berry's
  // `up -R` is project-wide and reads the project's .yarnrc.yml.
  pinMembers: (cwd) => !isYarnBerry(cwd),
}

export default yarn
