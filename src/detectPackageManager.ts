import fs from "fs"
import path from "path"

import type { SupportedPackageManager } from "@/types"

const packageManagers: Array<SupportedPackageManager> = [
  "npm",
  "yarn",
  "pnpm",
  "bun",
]

const lockFileNames: Record<string, string> = {
  npm: "package-lock.json",
  yarn: "yarn.lock",
  pnpm: "pnpm-lock.yaml",
  bun: "bun.lock",
}

const detectPackageManager = (cwd: string): SupportedPackageManager => {
  let pm = null

  for (const manager of packageManagers) {
    const lockFilePath = path.join(cwd, lockFileNames[manager])

    if (fs.existsSync(lockFilePath)) pm = manager
  }

  if (!pm) {
    console.error("No package manager detected in the current directory.")

    return process.exit(1)
  }

  return pm
}

export default detectPackageManager
