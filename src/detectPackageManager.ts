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
import logger from '@/utils/logger'

/** Managers package.json names, and the field that names them. */
interface Declaration {
  names: string[]
  field: 'packageManager' | 'devEngines.packageManager'
  value: string
}

/**
 * `packageManager` (`pnpm@12.14.0+sha512.…`, what Corepack enforces), then
 * `devEngines.packageManager`: one `{ name, version?, onFail? }` or an array
 * of them, listing the managers the project accepts in order of preference.
 */
const declarations = (cwd: string): Declaration[] => {
  const manifest = readManifest(cwd)
  const found: Declaration[] = []

  const packageManager = manifest?.packageManager
  if (typeof packageManager === 'string' && packageManager.trim()) {
    const value = packageManager.trim()
    found.push({ names: [value.split('@')[0]], field: 'packageManager', value })
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
      names,
      field: 'devEngines.packageManager',
      value: JSON.stringify(devEngines?.packageManager),
    })
  }

  return found
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
 * Picks the manager for `cwd`: `--pm` first, then what package.json
 * declares, then the lockfile. A lockfile that disagrees with the declared
 * manager is a leftover and is only logged at debug level, unless the
 * declared manager has no lockfile of its own. With several lockfiles and
 * nothing declared, the last in `adapters` order wins (bun, pnpm, yarn,
 * then npm: package-lock.json is the one most often left behind) and a
 * warning names the choice.
 */
const detectPackageManager = (
  cwd: string,
  pm?: SupportedPackageManager,
): SupportedPackageManager => {
  const found = Object.values(adapters).filter((adapter) =>
    fs.existsSync(path.join(cwd, adapter.lockfile)),
  )
  const declared = declarations(cwd)

  if (pm) {
    const contradicted = declared.find(
      ({ names }) => !names.includes(pm) && names.some(isSupportedManager),
    )
    if (contradicted) {
      logger.warn(
        `--pm ${pm} overrides ${contradicted.field} ${contradicted.value} in package.json. With Corepack enabled, ${pm} may refuse to run here.`,
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
        `package.json declares ${first.field} ${first.value}, and autd supports ${supportedManagers.join(', ')}. Pass --pm to choose one.`,
      )
    }

    const supported = usable.names.filter(isSupportedManager)
    // Of the managers devEngines accepts, the one the project has a lockfile for.
    const name =
      supported.find((name) => found.some((a) => a.name === name)) ??
      supported[0]
    logger.debug(`Using ${name}: ${usable.field} in package.json`)

    if (found.length > 0 && !found.some((a) => a.name === name)) {
      logger.warn(
        `package.json declares ${name} in ${usable.field}, but the only lockfile is ${found.map((a) => a.lockfile).join(', ')}. Using ${name}.`,
      )
    } else {
      ignoreOtherLockfiles(found, name, `package.json declares ${name}`)
    }
    return name
  }

  const chosen = found.at(-1)
  if (!chosen) {
    throw new StepError(
      'detect',
      `No package manager detected in the current directory: package.json declares none and there is no lockfile. Pass --pm ${supportedManagers.join('|')} to choose one.`,
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
