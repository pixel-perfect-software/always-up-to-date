import { MigrationAdvisor } from "../services/migration-advisor";
import { logger } from "../utils/logger";
import * as fs from "fs";
import * as path from "path";
import { green, blue, yellow, cyan, bold, gray } from "colorette";

interface MigrateOptions {
  projectPath: string;
  package?: string;
  fromVersion?: string;
  toVersion?: string;
  verbose: boolean;
  listSupported: boolean;
  searchTag?: string;
  customRules?: string;
}

export async function migrateCommand(options: MigrateOptions): Promise<void> {
  try {
    // Initialize migration advisor
    const advisor = new MigrationAdvisor(undefined, options.customRules);

    if (options.verbose) {
      logger.info(
        `Migration Advisor initialized with options: ${JSON.stringify(
          options,
          null,
          2
        )}`
      );
    }

    // Handle list supported packages
    if (options.listSupported) {
      const supported = advisor.getSupportedPackages();

      logger.info(bold(blue("\n📦 Supported Packages for Migration:")));
      logger.info(gray("──────────────────────────────────────"));

      if (supported.length === 0) {
        logger.warn("No migration providers found.");
        return;
      }

      supported.forEach((pkg) => {
        logger.info(`  ${green("✓")} ${pkg}`);
      });

      logger.info(gray(`\nTotal: ${supported.length} packages\n`));
      return;
    }

    // Handle search by tag
    if (options.searchTag) {
      const packages = advisor.searchProvidersByTag(options.searchTag);

      logger.info(
        bold(blue(`\n🏷️  Packages tagged with "${options.searchTag}":`))
      );
      logger.info(gray("──────────────────────────────────────"));

      if (packages.length === 0) {
        logger.warn("No packages found with this tag.");
        logger.info(
          gray(
            "Available tags: framework, testing, linting, build-tool, transpiler"
          )
        );
      } else {
        packages.forEach((pkg) => {
          logger.info(`  ${green("✓")} ${pkg}`);
        });
      }

      logger.info(gray(`\nFound: ${packages.length} packages\n`));
      return;
    }

    // Handle specific package migration
    if (options.package) {
      if (!options.fromVersion || !options.toVersion) {
        // Try to get versions from package.json
        const projectPath = path.resolve(options.projectPath || process.cwd());
        const packageJsonPath = path.join(projectPath, "package.json");

        if (!fs.existsSync(packageJsonPath)) {
          logger.error(
            "package.json not found. Please specify --from-version and --to-version"
          );
          process.exit(1);
        }

        logger.error(
          "Please specify both --from-version and --to-version for migration instructions"
        );
        logger.info(
          gray(
            "Example: alwaysuptodate migrate --package react --from-version 17.0.0 --to-version 18.0.0"
          )
        );
        process.exit(1);
      }

      logger.info(
        bold(blue(`\n🔄 Getting migration instructions for ${options.package}`))
      );
      logger.info(
        gray(`   From: ${options.fromVersion} → To: ${options.toVersion}\n`)
      );

      const instructions = await advisor.getMigrationInstructions(
        options.package,
        options.fromVersion,
        options.toVersion
      );

      // Output the migration instructions without additional formatting
      console.log(instructions);
      return;
    }

    // Show all outdated packages in the project and their migration info
    const projectPath = path.resolve(options.projectPath || process.cwd());
    await showProjectMigrationInfo(projectPath, advisor, options.verbose);
  } catch (error) {
    logger.error(`Migration command failed: ${(error as Error).message}`);
    if (options.verbose) {
      logger.debug(`Stack trace: ${(error as Error).stack}`);
    }
    process.exit(1);
  }
}

async function showProjectMigrationInfo(
  projectPath: string,
  advisor: MigrationAdvisor,
  verbose: boolean
): Promise<void> {
  const packageJsonPath = path.join(projectPath, "package.json");

  if (!fs.existsSync(packageJsonPath)) {
    logger.error("package.json not found in project directory");
    logger.info(gray("Make sure you're in a valid Node.js project directory"));
    process.exit(1);
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const dependencies = {
    ...packageJson.dependencies,
    ...packageJson.devDependencies,
  };

  const supportedPackages = advisor.getSupportedPackages();
  const projectSupportedPackages = Object.keys(dependencies).filter((pkg) =>
    supportedPackages.includes(pkg)
  );

  if (projectSupportedPackages.length === 0) {
    logger.warn(yellow("\n⚠️  No supported packages found in your project."));
    logger.info(gray("   Use --list-supported to see all supported packages."));
    logger.info(gray("   Use --search-tag to find packages by category."));
    console.log();
    return;
  }

  logger.info(bold(blue("\n📋 Migration Support Available for Your Project:")));
  logger.info(gray("─────────────────────────────────────────────────"));

  for (const pkg of projectSupportedPackages) {
    const currentVersion = dependencies[pkg];
    logger.info(`  ${green("✓")} ${bold(pkg)}`);
    logger.info(gray(`    Current: ${currentVersion}`));

    if (verbose) {
      logger.info(
        gray(
          `    Command: ${cyan(
            `alwaysuptodate migrate --package ${pkg} --from-version <current> --to-version <target>`
          )}`
        )
      );
    }
    console.log();
  }

  logger.info(bold(blue("💡 Tips:")));
  logger.info(
    gray("   • Use --package to get specific migration instructions")
  );
  logger.info(
    gray(
      "   • Use --search-tag to find packages by category (e.g., 'framework', 'testing')"
    )
  );
  logger.info(gray("   • Use --custom-rules to load your own migration rules"));
  logger.info(gray("   • Use --verbose for detailed output"));
  console.log();
}
