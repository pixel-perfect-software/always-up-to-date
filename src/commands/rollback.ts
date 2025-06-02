import { logger } from "../utils/logger";
import { bold, green, yellow, red, cyan } from "colorette";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";

export interface RollbackResult {
  success: boolean;
  rolledBack: string[];
  errors: string[];
}

export const rollbackDependencies = async (
  args?: any
): Promise<RollbackResult> => {
  try {
    const projectPath = args?.projectPath || process.cwd();
    const backupPath = join(projectPath, "package.json.backup");

    logger.info(cyan("🔄 Checking for backup files..."));

    if (!existsSync(backupPath)) {
      logger.warn(yellow("⚠️  No backup file found (package.json.backup)"));
      logger.info(
        "Rollback is only possible if a backup was created before the last update."
      );
      return {
        success: false,
        rolledBack: [],
        errors: ["No backup file found"],
      };
    }

    const currentPackageJsonPath = join(projectPath, "package.json");

    if (!existsSync(currentPackageJsonPath)) {
      logger.error(red("❌ Current package.json not found"));
      return {
        success: false,
        rolledBack: [],
        errors: ["Current package.json not found"],
      };
    }

    // Read backup and current package.json
    const backupContent = JSON.parse(readFileSync(backupPath, "utf8"));
    const currentContent = JSON.parse(
      readFileSync(currentPackageJsonPath, "utf8")
    );

    // Compare dependencies to see what changed
    const changes = detectChanges(currentContent, backupContent);

    if (changes.length === 0) {
      logger.info(
        green("✅ No dependency changes detected between current and backup.")
      );
      return { success: true, rolledBack: [], errors: [] };
    }

    logger.info(
      bold(
        yellow(`\n📋 Found ${changes.length} dependency changes to rollback:`)
      )
    );
    changes.forEach((change) => {
      logger.info(`  • ${change.name}: ${change.current} → ${change.backup}`);
    });

    // Restore package.json from backup
    logger.info(cyan("\n🔄 Restoring package.json from backup..."));
    writeFileSync(
      currentPackageJsonPath,
      JSON.stringify(backupContent, null, 2)
    );

    // Reinstall dependencies
    logger.info(cyan("📦 Reinstalling dependencies..."));

    try {
      // Run npm install to restore dependencies based on the restored package.json
      const command = `npm install`;
      const { execSync } = require("child_process");
      execSync(command, { cwd: projectPath, stdio: "inherit" });
      logger.info(green("✅ Dependencies successfully rolled back!"));

      // Clean up backup file
      if (args?.cleanupBackup !== false) {
        logger.info(cyan("🧹 Cleaning up backup file..."));
        require("fs").unlinkSync(backupPath);
      }

      return {
        success: true,
        rolledBack: changes.map((c) => c.name),
        errors: [],
      };
    } catch (installError) {
      logger.error(red("❌ Error reinstalling dependencies:"));
      logger.error((installError as Error).message);

      // Restore current package.json if install fails
      writeFileSync(
        currentPackageJsonPath,
        JSON.stringify(currentContent, null, 2)
      );

      return {
        success: false,
        rolledBack: [],
        errors: [`Install failed: ${(installError as Error).message}`],
      };
    }
  } catch (error) {
    logger.error(red(`Error during rollback: ${(error as Error).message}`));
    return {
      success: false,
      rolledBack: [],
      errors: [(error as Error).message],
    };
  }
};

interface DependencyChange {
  name: string;
  current: string;
  backup: string;
}

function detectChanges(current: any, backup: any): DependencyChange[] {
  const changes: DependencyChange[] = [];

  const currentDeps = {
    ...(current.dependencies || {}),
    ...(current.devDependencies || {}),
  };
  const backupDeps = {
    ...(backup.dependencies || {}),
    ...(backup.devDependencies || {}),
  };

  // Check for version changes
  for (const [name, currentVersion] of Object.entries(currentDeps)) {
    const backupVersion = backupDeps[name as string];
    if (backupVersion && backupVersion !== currentVersion) {
      changes.push({
        name,
        current: currentVersion as string,
        backup: backupVersion as string,
      });
    }
  }

  // Check for removed dependencies
  for (const [name, backupVersion] of Object.entries(backupDeps)) {
    if (!currentDeps[name]) {
      changes.push({
        name,
        current: "(removed)",
        backup: backupVersion as string,
      });
    }
  }

  return changes;
}

// Helper function to create backup before updates
export const createBackup = async (projectPath?: string): Promise<boolean> => {
  try {
    const path = projectPath || process.cwd();
    const packageJsonPath = join(path, "package.json");
    const backupPath = join(path, "package.json.backup");

    if (!existsSync(packageJsonPath)) {
      logger.error(red("❌ package.json not found"));
      return false;
    }

    const content = readFileSync(packageJsonPath, "utf8");
    writeFileSync(backupPath, content);

    logger.info(cyan("💾 Backup created: package.json.backup"));
    return true;
  } catch (error) {
    logger.error(red(`Error creating backup: ${(error as Error).message}`));
    return false;
  }
};

// For backwards compatibility
export const rollback = rollbackDependencies;
