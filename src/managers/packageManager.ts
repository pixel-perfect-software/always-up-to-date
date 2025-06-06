import BunManager from "@/managers/bun"
import NPMManager from "@/managers/npm"
import PNPMManager from "@/managers/pnpm"
import YarnManager from "@/managers/yarn"

import type { SupportedPackageManager } from "@/types"

class PackageManager {
  public readonly manager: NPMManager | YarnManager | PNPMManager | BunManager

  constructor(private readonly name: SupportedPackageManager) {
    this.manager = this.getManager(name)
  }

  private getManager(
    name: SupportedPackageManager,
  ): NPMManager | YarnManager | PNPMManager | BunManager {
    switch (name) {
      case "npm":
        return new NPMManager()
      case "yarn":
        return new YarnManager()
      case "pnpm":
        return new PNPMManager()
      case "bun":
        return new BunManager()
      default:
        throw new Error(`Unsupported package manager: ${this.name}`)
    }
  }
}

export default PackageManager
