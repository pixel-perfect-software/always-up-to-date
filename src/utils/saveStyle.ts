import fs from 'fs'
import path from 'path'
import { isYarnBerry } from '@/detectPackageManager'
import type { SupportedPackageManager } from '@/types'
import { loadNpmrc, npmrcBoolean } from './npmrcLoader'

/** How the project's package manager writes a new spec: exact, or with a prefix. */
export interface SaveStyle {
  exact: boolean
  prefix: string
}

export const DEFAULT_SAVE_STYLE: SaveStyle = { exact: false, prefix: '^' }

const readFile = (file: string): string => {
  try {
    return fs.readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** A top-level `key: value` from a YAML file, quotes removed. */
const yamlValue = (content: string, key: string): string | undefined => {
  const match = new RegExp(`^${key}:\\s*(['"]?)(.*?)\\1\\s*(#.*)?$`, 'm').exec(
    content,
  )
  return match?.[2]
}

/** `exact = true` inside bunfig.toml's `[install]` table. */
const bunfigExact = (content: string): boolean => {
  let inInstall = false
  for (const line of content.split('\n')) {
    const table = /^\s*\[([^\]]+)\]/.exec(line)
    if (table) {
      inInstall = table[1].trim() === 'install'
      continue
    }
    if (inInstall && /^\s*exact\s*=\s*true\s*(#.*)?$/.test(line)) return true
  }
  return false
}

/**
 * The save style each manager's current version uses for a new entry,
 * read from where that version keeps it (each verified with a real `add`):
 * - npm: `save-exact` / `save-prefix` in .npmrc
 * - pnpm: `saveExact` / `savePrefix` in pnpm-workspace.yaml (pnpm 12 ignores
 *   .npmrc for these)
 * - yarn berry: `defaultSemverRangePrefix` in .yarnrc.yml, where `''` means
 *   exact. Yarn v1 keeps the default.
 * - bun: `exact` in bunfig.toml's `[install]`, or `save-exact` in .npmrc;
 *   bun has no prefix setting
 */
export const readSaveStyle = (
  cwd: string,
  packageManager: SupportedPackageManager,
): SaveStyle => {
  switch (packageManager) {
    case 'npm': {
      const npmrc = loadNpmrc(cwd)
      const prefix = npmrc['save-prefix']
      return {
        exact: npmrcBoolean(npmrc['save-exact']) ?? false,
        prefix: typeof prefix === 'string' ? prefix : DEFAULT_SAVE_STYLE.prefix,
      }
    }
    case 'pnpm': {
      const yaml = readFile(path.join(cwd, 'pnpm-workspace.yaml'))
      return {
        exact: yamlValue(yaml, 'saveExact') === 'true',
        prefix: yamlValue(yaml, 'savePrefix') ?? DEFAULT_SAVE_STYLE.prefix,
      }
    }
    case 'yarn': {
      if (!isYarnBerry(cwd)) return DEFAULT_SAVE_STYLE
      const prefix = yamlValue(
        readFile(path.join(cwd, '.yarnrc.yml')),
        'defaultSemverRangePrefix',
      )
      if (prefix === undefined) return DEFAULT_SAVE_STYLE
      return { exact: prefix === '', prefix }
    }
    case 'bun':
      return {
        exact:
          bunfigExact(readFile(path.join(cwd, 'bunfig.toml'))) ||
          (npmrcBoolean(loadNpmrc(cwd)['save-exact']) ?? false),
        prefix: DEFAULT_SAVE_STYLE.prefix,
      }
  }
}
