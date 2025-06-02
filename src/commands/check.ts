import { checkForUpdates } from "../services/dependency-checker";
import { PackageManagerDetector } from "../utils/package-manager";
import { logger } from "../utils/logger";
import { checkbox, confirm } from "@inquirer/prompts";
import { green, yellow, red, cyan, magenta, bold } from "colorette";

export interface CheckResult {
  updatable: Array<{
    name: string;
    currentVersion: string;
    installedVersion?: string;
    newVersion: string;
  }>;
  breakingChanges: Array<{
    name: string;
    currentVersion: string;
    installedVersion?: string;
    newVersion: string;
    migrationInstructions?: string;
  }>;
}

interface UpdateChoice {
  name: string;
  value: string;
  description?: string;
  type: "safe" | "breaking";
}

export const checkDependencies = async (args?: any): Promise<CheckResult> => {
  try {
    const isPreview = args?.preview || false;
    const isInteractive = args?.interactive || false;

    if (isPreview) {
      logger.info(cyan("🔍 Preview Mode: Checking for dependency updates..."));
    } else if (isInteractive) {
      logger.info(
        magenta("🔄 Interactive Mode: Checking for dependency updates...")
      );
    } else {
      logger.info("Checking for dependency updates...");
    }

    const { updatable, breakingChanges } = await checkForUpdates(
      args?.projectPath
    );

    if (updatable.length === 0 && breakingChanges.length === 0) {
      logger.info(green("✅ All dependencies are up to date."));
      return { updatable: [], breakingChanges: [] };
    }

    // Preview Mode - Show detailed information without applying changes
    if (isPreview) {
      return await handlePreviewMode(updatable, breakingChanges);
    }

    // Interactive Mode - Let user choose what to update
    if (isInteractive) {
      return await handleInteractiveMode(
        updatable,
        breakingChanges,
        args?.projectPath
      );
    }

    // Default Mode - Just display information
    return await handleDefaultMode(updatable, breakingChanges);
  } catch (error) {
    logger.error(
      red(
        `An error occurred while checking dependencies: ${
          (error as Error).message
        }`
      )
    );
    return { updatable: [], breakingChanges: [] };
  }
};

async function handlePreviewMode(
  updatable: any[],
  breakingChanges: any[]
): Promise<CheckResult> {
  logger.info(bold(cyan("\n📋 PREVIEW REPORT")));
  logger.info("=".repeat(50));

  if (updatable.length > 0) {
    logger.info(bold(green(`\n✅ Safe Updates (${updatable.length})`)));
    updatable.forEach((update) => {
      const currentVer =
        update.installedVersion &&
        update.installedVersion !== update.currentVersion
          ? `${update.currentVersion} (pkg.json) / ${update.installedVersion} (installed)`
          : update.currentVersion;

      logger.info(`  📦 ${bold(update.name)}`);
      logger.info(`     ${yellow("Current:")} ${currentVer}`);
      logger.info(`     ${green("Update to:")} ${update.newVersion}`);
      logger.info(`     ${cyan("Type:")} Minor/Patch - Safe to update`);
      logger.info("");
    });
  }

  if (breakingChanges.length > 0) {
    logger.info(
      bold(yellow(`\n⚠️  Breaking Changes (${breakingChanges.length})`))
    );
    breakingChanges.forEach((update) => {
      const currentVer =
        update.installedVersion &&
        update.installedVersion !== update.currentVersion
          ? `${update.currentVersion} (pkg.json) / ${update.installedVersion} (installed)`
          : update.currentVersion;

      logger.info(`  📦 ${bold(update.name)}`);
      logger.info(`     ${yellow("Current:")} ${currentVer}`);
      logger.info(`     ${red("Update to:")} ${update.newVersion}`);
      logger.info(`     ${red("Type:")} Major - Requires manual review`);
      if (update.migrationInstructions) {
        logger.info(`     ${magenta("Migration:")} Available`);
      }
      logger.info("");
    });
  }

  logger.info(
    cyan(
      "\n💡 Preview complete. Use --interactive to select updates or run without flags to see basic info."
    )
  );

  return { updatable, breakingChanges };
}

async function handleInteractiveMode(
  updatable: any[],
  breakingChanges: any[],
  projectPath?: string
): Promise<CheckResult> {
  logger.info(bold(magenta("\n🔄 INTERACTIVE MODE")));
  logger.info("=".repeat(50));

  const choices: UpdateChoice[] = [];

  // Add safe updates
  updatable.forEach((update) => {
    choices.push({
      name: `${green("✅")} ${update.name} ${yellow(
        update.currentVersion
      )} → ${green(update.newVersion)} ${cyan("(safe)")}`,
      value: `safe:${update.name}`,
      type: "safe",
    });
  });

  // Add breaking changes
  breakingChanges.forEach((update) => {
    choices.push({
      name: `${yellow("⚠️")} ${update.name} ${yellow(
        update.currentVersion
      )} → ${red(update.newVersion)} ${red("(breaking)")}`,
      value: `breaking:${update.name}`,
      type: "breaking",
    });
  });

  if (choices.length === 0) {
    logger.info(green("✅ No updates available."));
    return { updatable: [], breakingChanges: [] };
  }

  // Let user select which packages to update
  const selectedUpdates = await checkbox({
    message: "Select packages to update:",
    choices: choices.map((choice) => ({
      name: choice.name,
      value: choice.value,
    })),
    instructions: "Use space to select, enter to continue",
  });

  if (selectedUpdates.length === 0) {
    logger.info(yellow("No packages selected for update."));
    return { updatable, breakingChanges };
  }

  // Show migration instructions for breaking changes
  const breakingSelected = selectedUpdates.filter((update) =>
    update.startsWith("breaking:")
  );
  if (breakingSelected.length > 0) {
    logger.info(bold(yellow("\n⚠️  BREAKING CHANGES DETECTED")));
    logger.info("The following packages have breaking changes:");

    for (const selected of breakingSelected) {
      const packageName = selected.replace("breaking:", "");
      const update = breakingChanges.find((u) => u.name === packageName);

      if (update?.migrationInstructions) {
        logger.info(`\n${bold(packageName)}:`);
        logger.info(update.migrationInstructions);
      }
    }

    const confirmBreaking = await confirm({
      message: "Do you want to continue with these breaking changes?",
      default: false,
    });

    if (!confirmBreaking) {
      logger.info(yellow("Update cancelled."));
      return { updatable, breakingChanges };
    }
  }

  // Confirm before applying updates
  const confirmUpdate = await confirm({
    message: `Apply ${selectedUpdates.length} package update(s)?`,
    default: true,
  });

  if (!confirmUpdate) {
    logger.info(yellow("Update cancelled."));
    return { updatable, breakingChanges };
  }

  // Apply selected updates
  logger.info(cyan("\n🔄 Applying updates..."));

  try {
    const packagesToUpdate = selectedUpdates
      .map((selected) => {
        const [type, packageName] = selected.split(":");
        if (type === "safe") {
          const update = updatable.find((u) => u.name === packageName);
          return update;
        } else {
          const update = breakingChanges.find((u) => u.name === packageName);
          return update;
        }
      })
      .filter(Boolean);

    await updateSelectedDependencies(packagesToUpdate, projectPath);
    logger.info(green("✅ Updates applied successfully!"));
  } catch (error) {
    logger.error(red(`❌ Error applying updates: ${(error as Error).message}`));
  }

  return { updatable, breakingChanges };
}

/**
 * Helper function to update specific dependencies
 */
async function updateSelectedDependencies(
  packages: any[],
  projectPath?: string
): Promise<void> {
  const packageManager = PackageManagerDetector.detect(
    projectPath || process.cwd()
  );

  for (const pkg of packages) {
    if (pkg && pkg.name && pkg.newVersion) {
      logger.info(cyan(`Updating ${pkg.name} to ${pkg.newVersion}...`));
      await packageManager.updateDependency(
        projectPath || process.cwd(),
        pkg.name,
        pkg.newVersion
      );
    }
  }
}

async function handleDefaultMode(
  updatable: any[],
  breakingChanges: any[]
): Promise<CheckResult> {
  if (updatable.length > 0) {
    logger.info(green("\n📦 The following dependencies can be updated:"));
    updatable.forEach((update) => {
      if (
        update.installedVersion &&
        update.installedVersion !== update.currentVersion
      ) {
        logger.info(
          `  • ${bold(update.name)}: ${yellow(
            update.currentVersion
          )} (defined in package.json) / ${yellow(
            update.installedVersion
          )} (actually installed) → ${green(update.newVersion)}`
        );
      } else {
        logger.info(
          `  • ${bold(update.name)}: ${yellow(update.currentVersion)} → ${green(
            update.newVersion
          )}`
        );
      }
    });
  }

  if (breakingChanges.length > 0) {
    logger.warn(
      yellow("\n⚠️  The following dependencies have breaking changes:")
    );
    breakingChanges.forEach((update) => {
      if (
        update.installedVersion &&
        update.installedVersion !== update.currentVersion
      ) {
        logger.warn(
          `  • ${bold(update.name)}: ${yellow(
            update.currentVersion
          )} (defined in package.json) / ${yellow(
            update.installedVersion
          )} (actually installed) → ${red(update.newVersion)}`
        );
      } else {
        logger.warn(
          `  • ${bold(update.name)}: ${yellow(update.currentVersion)} → ${red(
            update.newVersion
          )}`
        );
      }
      if (update.migrationInstructions) {
        logger.debug(
          "    Migration instructions available (use --interactive to view)"
        );
      }
    });
  }

  logger.info(
    cyan(
      "\n💡 Tip: Use --interactive to select specific updates or --preview for detailed information."
    )
  );

  return { updatable, breakingChanges };
}

// For backwards compatibility with older code that might use this
export const check = checkDependencies;
