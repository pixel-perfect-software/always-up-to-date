#!/usr/bin/env node

/**
 * Performance test script to validate the optimizations
 * This script creates a mock monorepo structure and tests dependency checking speed
 */

import { join } from "path";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "fs";
import { DependencyChecker } from "../src/services/dependency-checker";
import { CacheManager } from "../src/services/cache-manager";
import { logger } from "../src/utils/logger";
import { green, yellow, cyan, bold, red } from "colorette";

interface TestResult {
  packageCount: number;
  firstRunTime: number;
  secondRunTime: number;
  improvement: number;
  cacheHitRate: number;
}

async function createMockMonorepo(
  testDir: string,
  packageCount: number = 50
): Promise<void> {
  logger.info(`Creating mock monorepo with ${packageCount} packages...`);

  // Create root package.json
  const rootPackageJson = {
    name: "test-monorepo",
    version: "1.0.0",
    workspaces: ["packages/*"],
    devDependencies: {
      typescript: "^5.0.0",
      eslint: "^8.0.0",
      prettier: "^3.0.0",
    },
  };

  writeFileSync(
    join(testDir, "package.json"),
    JSON.stringify(rootPackageJson, null, 2)
  );

  // Create packages directory
  const packagesDir = join(testDir, "packages");
  mkdirSync(packagesDir, { recursive: true });

  // Popular packages to randomly select from
  const popularPackages = [
    "react",
    "react-dom",
    "lodash",
    "axios",
    "express",
    "moment",
    "uuid",
    "chalk",
    "commander",
    "fs-extra",
    "glob",
    "rimraf",
    "semver",
    "yargs",
    "@types/node",
    "@types/react",
    "@types/lodash",
    "@types/express",
    "jest",
    "mocha",
    "chai",
    "supertest",
    "sinon",
    "cypress",
    "webpack",
    "babel-core",
    "eslint-config-prettier",
    "husky",
    "lint-staged",
    "cross-env",
    "dotenv",
    "nodemon",
    "concurrently",
    "npm-run-all",
    "webpack-cli",
    "webpack-dev-server",
    "ts-loader",
    "css-loader",
    "style-loader",
    "html-webpack-plugin",
    "mini-css-extract-plugin",
    "terser-webpack-plugin",
    "compression-webpack-plugin",
    "copy-webpack-plugin",
  ];

  // Create individual packages
  for (let i = 1; i <= packageCount; i++) {
    const packageDir = join(packagesDir, `package-${i}`);
    mkdirSync(packageDir, { recursive: true });

    // Randomly select 5-15 dependencies per package
    const depCount = Math.floor(Math.random() * 10) + 5;
    const selectedDeps = [...popularPackages]
      .sort(() => 0.5 - Math.random())
      .slice(0, depCount);

    const dependencies: Record<string, string> = {};
    const devDependencies: Record<string, string> = {};

    selectedDeps.forEach((pkg, index) => {
      const version = `^${Math.floor(Math.random() * 5) + 1}.${Math.floor(
        Math.random() * 10
      )}.${Math.floor(Math.random() * 10)}`;
      if (index < depCount / 2) {
        dependencies[pkg] = version;
      } else {
        devDependencies[pkg] = version;
      }
    });

    const packageJson = {
      name: `@test/package-${i}`,
      version: "1.0.0",
      dependencies,
      devDependencies,
    };

    writeFileSync(
      join(packageDir, "package.json"),
      JSON.stringify(packageJson, null, 2)
    );
  }

  logger.info(green(`✅ Created mock monorepo with ${packageCount} packages`));
}

async function runPerformanceTest(testDir: string): Promise<TestResult> {
  const checker = new DependencyChecker(testDir);
  const cacheManager = new CacheManager(testDir);

  // Clear cache to ensure clean test
  cacheManager.clearCache();

  logger.info(yellow("🏃 Running first dependency check (cold cache)..."));
  const firstRunStart = Date.now();
  const firstResult = await checker.checkForUpdates();
  const firstRunTime = Date.now() - firstRunStart;

  const totalPackages =
    firstResult.updatable.length + firstResult.breakingChanges.length;

  logger.info(
    cyan(`First run completed in ${(firstRunTime / 1000).toFixed(2)}s`)
  );
  logger.info(
    `Found ${firstResult.updatable.length} updatable and ${firstResult.breakingChanges.length} breaking changes`
  );

  // Get cache stats after first run
  const cacheStatsAfterFirst = cacheManager.getCacheStats();

  logger.info(yellow("🏃 Running second dependency check (warm cache)..."));
  const secondRunStart = Date.now();
  const secondResult = await checker.checkForUpdates();
  const secondRunTime = Date.now() - secondRunStart;

  logger.info(
    cyan(`Second run completed in ${(secondRunTime / 1000).toFixed(2)}s`)
  );

  const improvement = ((firstRunTime - secondRunTime) / firstRunTime) * 100;
  const cacheHitRate =
    cacheStatsAfterFirst.versionEntries > 0
      ? (cacheStatsAfterFirst.versionEntries / Math.max(totalPackages, 1)) * 100
      : 0;

  return {
    packageCount: totalPackages,
    firstRunTime,
    secondRunTime,
    improvement,
    cacheHitRate,
  };
}

function printResults(results: TestResult[]): void {
  logger.info(cyan(bold("\n📊 Performance Test Results")));
  logger.info("=".repeat(60));

  for (const result of results) {
    logger.info(`\n${bold(`${result.packageCount} packages:`)}`);
    logger.info(`  First run:     ${(result.firstRunTime / 1000).toFixed(2)}s`);
    logger.info(
      `  Second run:    ${(result.secondRunTime / 1000).toFixed(2)}s`
    );

    if (result.improvement > 0) {
      logger.info(
        green(`  Improvement:   ${result.improvement.toFixed(1)}% faster`)
      );
    } else {
      logger.info(
        red(
          `  Difference:    ${Math.abs(result.improvement).toFixed(1)}% slower`
        )
      );
    }

    logger.info(`  Cache hit rate: ${result.cacheHitRate.toFixed(1)}%`);
  }

  const avgImprovement =
    results.reduce((sum, r) => sum + r.improvement, 0) / results.length;

  logger.info(cyan(bold("\n🎯 Summary:")));
  if (avgImprovement > 50) {
    logger.info(
      green(
        `✅ Excellent performance: ${avgImprovement.toFixed(
          1
        )}% average improvement`
      )
    );
  } else if (avgImprovement > 20) {
    logger.info(
      green(
        `✅ Good performance: ${avgImprovement.toFixed(1)}% average improvement`
      )
    );
  } else if (avgImprovement > 0) {
    logger.info(
      yellow(
        `⚠️  Moderate improvement: ${avgImprovement.toFixed(
          1
        )}% average improvement`
      )
    );
  } else {
    logger.info(
      red(
        `❌ Performance regression: ${Math.abs(avgImprovement).toFixed(
          1
        )}% slower`
      )
    );
  }
}

async function main(): Promise<void> {
  const testDir = join(process.cwd(), ".performance-test");

  try {
    logger.info(bold("🚀 Starting Performance Test Suite"));
    logger.info(
      "Testing bulk processing, caching, and workspace optimizations"
    );

    // Clean up any existing test directory
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
    mkdirSync(testDir, { recursive: true });

    const results: TestResult[] = [];
    const packageCounts = [25, 50, 100]; // Test with different sizes

    for (const packageCount of packageCounts) {
      logger.info(yellow(`\n🔧 Testing with ${packageCount} packages...`));

      // Create fresh monorepo for each test
      if (existsSync(testDir)) {
        rmSync(testDir, { recursive: true, force: true });
      }
      mkdirSync(testDir, { recursive: true });

      await createMockMonorepo(testDir, packageCount);
      const result = await runPerformanceTest(testDir);
      results.push(result);
    }

    printResults(results);

    // Cleanup
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    logger.info(green("\n✅ Performance test completed successfully"));
  } catch (error) {
    logger.error(`Performance test failed: ${(error as Error).message}`);

    // Cleanup on error
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }

    process.exit(1);
  }
}

// Run the performance test if this file is executed directly
if (require.main === module) {
  main().catch((error) => {
    console.error("Performance test error:", error);
    process.exit(1);
  });
}

export { main as runPerformanceTest };
