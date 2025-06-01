import { MigrationRuleProvider } from "./types";
import { MigrationRuleRegistry } from "./registry";
import { logger } from "../../utils/logger";
import * as path from "path";
import * as fs from "fs";

export class MigrationPluginLoader {
  constructor(private registry: MigrationRuleRegistry) {}

  /**
   * Load migration rules from external files/packages
   */
  async loadFromDirectory(directory: string): Promise<void> {
    try {
      if (!fs.existsSync(directory)) {
        logger.debug(`Migration rules directory not found: ${directory}`);
        return;
      }

      const files = fs
        .readdirSync(directory)
        .filter((file) => file.endsWith(".js") || file.endsWith(".ts"));

      for (const file of files) {
        try {
          const filePath = path.join(directory, file);
          const module = await this.importModule(filePath);

          // Look for exported providers
          Object.values(module).forEach((exportedValue: any) => {
            if (this.isValidProvider(exportedValue)) {
              this.registry.registerProvider(new exportedValue());
              logger.info(`Loaded migration provider from ${file}`);
            }
          });
        } catch (error) {
          logger.warn(`Failed to load migration rules from ${file}: ${error}`);
        }
      }
    } catch (error) {
      logger.error(`Error loading migration plugins: ${error}`);
    }
  }

  /**
   * Wrapper for dynamic imports to make testing easier
   */
  protected async importModule(filePath: string): Promise<any> {
    return import(filePath);
  }

  /**
   * Load migration rules from JSON configuration
   */
  async loadFromConfig(configPath: string): Promise<void> {
    try {
      if (!fs.existsSync(configPath)) {
        logger.debug(`Migration config not found: ${configPath}`);
        return;
      }

      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

      if (config.migrationRules) {
        Object.entries(config.migrationRules).forEach(
          ([packageName, packageInfo]) => {
            const provider = this.createProviderFromConfig(
              packageName,
              packageInfo as any
            );
            this.registry.registerProvider(provider);
            logger.info(`Loaded migration config for ${packageName}`);
          }
        );
      }
    } catch (error) {
      logger.warn(
        `Failed to load migration config from ${configPath}: ${error}`
      );
    }
  }

  private isValidProvider(obj: any): boolean {
    return (
      typeof obj === "function" &&
      obj.prototype &&
      typeof obj.prototype.getPackageName === "function" &&
      typeof obj.prototype.getMigrationInfo === "function"
    );
  }

  private createProviderFromConfig(
    packageName: string,
    packageInfo: any
  ): MigrationRuleProvider {
    return {
      getPackageName: () => packageName,
      getMigrationInfo: () => packageInfo,
    };
  }
}
