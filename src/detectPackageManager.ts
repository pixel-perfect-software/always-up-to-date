import fs from 'fs'
import path from 'path'

import { adapters } from '@/managers'
import { StepError } from '@/stepError'
import type { SupportedPackageManager } from '@/types'

const detectPackageManager = (cwd: string): SupportedPackageManager => {
  let pm: SupportedPackageManager | null = null

  for (const adapter of Object.values(adapters)) {
    if (fs.existsSync(path.join(cwd, adapter.lockfile))) pm = adapter.name
  }

  if (!pm) {
    throw new StepError(
      'detect',
      'No package manager detected in the current directory.',
    )
  }

  return pm
}

export default detectPackageManager
