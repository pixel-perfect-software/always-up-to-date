import fs from 'fs'
import path from 'path'

import { StepError } from '@/stepError'
import type { SupportedPackageManager } from '@/types'

const packageManagers: Array<SupportedPackageManager> = [
  'npm',
  'yarn',
  'pnpm',
  'bun',
]

const lockFileNames: Record<string, string> = {
  npm: 'package-lock.json',
  yarn: 'yarn.lock',
  pnpm: 'pnpm-lock.yaml',
  bun: 'bun.lock',
}

const detectPackageManager = (cwd: string): SupportedPackageManager => {
  let pm = null

  for (const manager of packageManagers) {
    const lockFilePath = path.join(cwd, lockFileNames[manager])

    if (fs.existsSync(lockFilePath)) pm = manager
  }

  if (!pm) {
    throw new StepError(
      'detect',
      'No package manager detected in the current directory.',
    )
  }

  return pm
}

/**
 * Yarn 2+ ("berry") is identified by the `packageManager` field when it is
 * present, otherwise by a `.yarnrc.yml`, which yarn v1 does not use.
 */
export const isYarnBerry = (cwd: string): boolean => {
  try {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'),
    )
    const declared = /^yarn@(\d+)\./.exec(packageJson.packageManager ?? '')
    if (declared) return Number(declared[1]) >= 2
  } catch {
    // Unreadable manifest: fall back to the rc file.
  }

  return fs.existsSync(path.join(cwd, '.yarnrc.yml'))
}

export default detectPackageManager
