import fs from 'fs'
import path from 'path'

import {
  adapters,
  isSupportedManager,
  type ManagerAdapter,
  supportedManagers,
} from '@/managers'
import { readManifest } from '@/managers/workspaces'
import { StepError } from '@/stepError'
import type { SupportedPackageManager } from '@/types'
import { ancestorDirs } from '@/utils/ancestors'
import logger from '@/utils/logger'

/** Managers package.json names, and the field that names them. */
interface Declaration {
  /** The declaring file as seen from the command's cwd: `package.json`, `../../package.json`. */
  file: string
  names: string[]
  field: 'packageManager' | 'devEngines.packageManager'
  value: string
}

/**
 * `packageManager` (`pnpm@12.14.0+sha512.…`, what Corepack enforces), then
 * `devEngines.packageManager`: one `{ name, version?, onFail? }` or an array
 * of them, listing the managers the project accepts in order of preference.
 */
const declarationsIn = (dir: string, file: string): Declaration[] => {
  const manifest = readManifest(dir)
  const found: Declaration[] = []

  const packageManager = manifest?.packageManager
  if (typeof packageManager === 'string' && packageManager.trim()) {
    const value = packageManager.trim()
    found.push({
      file,
      names: [value.split('@')[0]],
      field: 'packageManager',
      value,
    })
  }

  const devEngines = manifest?.devEngines as
    | { packageManager?: unknown }
    | undefined
  const names = [devEngines?.packageManager]
    .flat()
    .map((entry) => (entry as { name?: unknown } | undefined)?.name)
    .filter((name): name is string => typeof name === 'string')
  if (names.length > 0) {
    found.push({
      file,
      names,
      field: 'devEngines.packageManager',
      value: JSON.stringify(devEngines?.packageManager),
    })
  }

  return found
}

/**
 * The declarations of the nearest package.json from `from` up to `root` that
 * has any (a member's own beats the workspace root's).
 */
const declarations = (
  root: string,
  from: string,
  cwd: string,
): Declaration[] => {
  for (const dir of ancestorDirs(from, root)) {
    const relative = path.relative(cwd, dir).split(path.sep).join('/')
    const found = declarationsIn(
      dir,
      relative ? `${relative}/package.json` : 'package.json',
    )
    if (found.length > 0) return found
  }
  return []
}

const ignoreOtherLockfiles = (
  found: ManagerAdapter[],
  chosen: SupportedPackageManager,
  because: string,
): void => {
  for (const adapter of found) {
    if (adapter.name !== chosen) {
      logger.debug(`Ignoring ${adapter.lockfile}: ${because}.`)
    }
  }
}

/**
 * Picks the manager for the project at `root`: `--pm` first, then what package.json
 * declares, then the lockfile. A lockfile that disagrees with the declared
 * manager is a leftover and is only logged at debug level, unless the
 * declared manager has no lockfile of its own. With several lockfiles and
 * nothing declared, the last in `adapters` order wins (bun, pnpm, yarn,
 * then npm: package-lock.json is the one most often left behind) and a
 * warning names the choice. Lockfiles are read at `root`. From a workspace
 * member (`from`, a directory below `root`), the declaration is the nearest
 * package.json's between `from` and `root`. Messages name files and
 * directories as seen from `cwd`, the command's directory (`from` by default).
 */
const detectPackageManager = (
  root: string,
  pm?: SupportedPackageManager,
  { from = root, cwd = from }: { from?: string; cwd?: string } = {},
): SupportedPackageManager => {
  const found = Object.values(adapters).filter((adapter) =>
    fs.existsSync(path.join(root, adapter.lockfile)),
  )
  const declared = declarations(root, from, cwd)

  if (pm) {
    const contradicted = declared.find(
      ({ names }) => !names.includes(pm) && names.some(isSupportedManager),
    )
    if (contradicted) {
      logger.warn(
        `--pm ${pm} overrides ${contradicted.field} ${contradicted.value} in ${contradicted.file}. With Corepack enabled, ${pm} may refuse to run here.`,
      )
    }
    logger.debug(`Using ${pm}: --pm ${pm}`)
    ignoreOtherLockfiles(found, pm, `--pm ${pm}`)
    return pm
  }

  if (declared.length > 0) {
    // The first declaration that names a manager autd supports.
    const usable = declared.find(({ names }) => names.some(isSupportedManager))
    if (!usable) {
      const [first] = declared
      throw new StepError(
        'detect',
        `${first.file} declares ${first.field} ${first.value}, and autd supports ${supportedManagers.join(', ')}. Pass --pm to choose one.`,
      )
    }

    const supported = usable.names.filter(isSupportedManager)
    // Of the managers devEngines accepts, the one the project has a lockfile for.
    const name =
      supported.find((name) => found.some((a) => a.name === name)) ??
      supported[0]
    logger.debug(`Using ${name}: ${usable.field} in ${usable.file}`)

    if (found.length > 0 && !found.some((a) => a.name === name)) {
      logger.warn(
        `${usable.file} declares ${name} in ${usable.field}, but the only lockfile is ${found.map((a) => a.lockfile).join(', ')}. Using ${name}.`,
      )
    } else {
      ignoreOtherLockfiles(found, name, `${usable.file} declares ${name}`)
    }
    return name
  }

  const chosen = found.at(-1)
  if (!chosen) {
    throw new StepError(
      'detect',
      `No package manager detected in ${path.resolve(cwd) === root ? 'the current directory' : root}: package.json declares none and there is no lockfile. Pass --pm ${supportedManagers.join('|')} to choose one.`,
    )
  }

  if (found.length > 1) {
    const preference = supportedManagers.toReversed()
    logger.warn(
      `Found ${found.map((a) => a.lockfile).join(', ')}; using ${chosen.name} (${chosen.lockfile}), since autd prefers ${preference.slice(0, -1).join(', ')}, then ${preference.at(-1)}. Set "packageManager" in package.json or pass --pm to choose.`,
    )
  } else {
    logger.debug(`Using ${chosen.name}: ${chosen.lockfile}`)
  }

  return chosen.name
}

export default detectPackageManager
