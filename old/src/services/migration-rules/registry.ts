import { MigrationRuleProvider, PackageMigrationInfo } from "./types"
import { ReactMigrationProvider } from "./providers/react"
import { NextJsMigrationProvider } from "./providers/nextjs"
import { TypeScriptMigrationProvider } from "./providers/typescript"
import { EslintMigrationProvider } from "./providers/eslint"
import { PrettierMigrationProvider } from "./providers/prettier"
import { JestMigrationProvider } from "./providers/jest"

export class MigrationRuleRegistry {
  private providers: Map<string, MigrationRuleProvider> = new Map()

  constructor() {
    this.registerDefaultProviders()
  }

  private registerDefaultProviders(): void {
    const defaultProviders = [
      new ReactMigrationProvider(),
      new NextJsMigrationProvider(),
      new TypeScriptMigrationProvider(),
      new EslintMigrationProvider(),
      new PrettierMigrationProvider(),
      new JestMigrationProvider(),
    ]

    defaultProviders.forEach((provider) => {
      this.registerProvider(provider)
    })
  }

  registerProvider(provider: MigrationRuleProvider): void {
    this.providers.set(provider.getPackageName(), provider)
  }

  unregisterProvider(packageName: string): void {
    this.providers.delete(packageName)
  }

  getProvider(packageName: string): MigrationRuleProvider | undefined {
    return this.providers.get(packageName)
  }

  getAllProviders(): MigrationRuleProvider[] {
    return Array.from(this.providers.values())
  }

  getPackageMigrationInfo(
    packageName: string,
  ): PackageMigrationInfo | undefined {
    const provider = this.getProvider(packageName)
    return provider?.getMigrationInfo()
  }

  listSupportedPackages(): string[] {
    return Array.from(this.providers.keys())
  }

  searchProvidersByTag(tag: string): MigrationRuleProvider[] {
    return this.getAllProviders().filter((provider) => {
      const info = provider.getMigrationInfo()
      return info.tags?.includes(tag)
    })
  }
}
