import { checkForUpdates } from "../services/dependency-checker";
import { logger } from "../utils/logger";
import { bold, green, yellow, red, cyan, magenta } from "colorette";

export interface DiffResult {
  changes: Array<{
    name: string;
    type: "safe" | "breaking";
    currentVersion: string;
    newVersion: string;
    changeType: "patch" | "minor" | "major";
    migrationInstructions?: string;
  }>;
  summary: {
    total: number;
    safe: number;
    breaking: number;
  };
}

export const showDependencyDiff = async (args?: any): Promise<DiffResult> => {
  try {
    logger.info(cyan("🔍 Analyzing dependency changes..."));

    const { updatable, breakingChanges } = await checkForUpdates(
      args?.projectPath
    );

    const changes = [
      ...updatable.map((dep) => ({
        name: dep.name,
        type: "safe" as const,
        currentVersion: dep.currentVersion,
        newVersion: dep.newVersion,
        changeType: getChangeType(dep.currentVersion, dep.newVersion),
      })),
      ...breakingChanges.map((dep) => ({
        name: dep.name,
        type: "breaking" as const,
        currentVersion: dep.currentVersion,
        newVersion: dep.newVersion,
        changeType: getChangeType(dep.currentVersion, dep.newVersion),
        migrationInstructions: dep.migrationInstructions,
      })),
    ];

    const summary = {
      total: changes.length,
      safe: updatable.length,
      breaking: breakingChanges.length,
    };

    if (changes.length === 0) {
      logger.info(green("✅ No dependency changes detected."));
      return { changes: [], summary };
    }

    displayDiff(changes, summary);

    return { changes, summary };
  } catch (error) {
    logger.error(
      red(`Error analyzing dependency changes: ${(error as Error).message}`)
    );
    return { changes: [], summary: { total: 0, safe: 0, breaking: 0 } };
  }
};

function getChangeType(
  current: string,
  newVersion: string
): "patch" | "minor" | "major" {
  const cleanCurrent = current.replace(/[\^~>=<]/g, "");

  const currentParts = cleanCurrent.split(".").map(Number);
  const newParts = newVersion.split(".").map(Number);

  if (newParts[0] > currentParts[0]) return "major";
  if (newParts[1] > currentParts[1]) return "minor";
  return "patch";
}

function displayDiff(changes: any[], summary: any): void {
  logger.info(bold(cyan("\n📊 DEPENDENCY DIFF REPORT")));
  logger.info("=".repeat(60));

  logger.info(bold(`\n📈 Summary: ${summary.total} total changes`));
  logger.info(`  ${green("✅")} Safe updates: ${summary.safe}`);
  logger.info(`  ${red("⚠️")} Breaking changes: ${summary.breaking}`);

  if (summary.safe > 0) {
    logger.info(bold(green("\n✅ Safe Updates:")));
    changes
      .filter((change) => change.type === "safe")
      .forEach((change) => {
        const icon = getChangeIcon(change.changeType);
        logger.info(`  ${icon} ${bold(change.name)}`);
        logger.info(
          `     ${yellow(change.currentVersion)} → ${green(
            change.newVersion
          )} ${cyan(`(${change.changeType})`)}`
        );
      });
  }

  if (summary.breaking > 0) {
    logger.info(bold(red("\n⚠️  Breaking Changes:")));
    changes
      .filter((change) => change.type === "breaking")
      .forEach((change) => {
        const icon = getChangeIcon(change.changeType);
        logger.info(`  ${icon} ${bold(change.name)}`);
        logger.info(
          `     ${yellow(change.currentVersion)} → ${red(
            change.newVersion
          )} ${red(`(${change.changeType})`)}`
        );
        if (change.migrationInstructions) {
          logger.info(`     ${magenta("📋")} Migration instructions available`);
        }
      });
  }

  logger.info(
    cyan(
      "\n💡 Use --interactive to select specific updates or run without flags to apply all safe updates."
    )
  );
}

function getChangeIcon(changeType: "patch" | "minor" | "major"): string {
  switch (changeType) {
    case "patch":
      return green("🔧"); // Small fix
    case "minor":
      return yellow("✨"); // New features
    case "major":
      return red("💥"); // Breaking changes
    default:
      return "📦";
  }
}

// For backwards compatibility
export const diff = showDependencyDiff;
