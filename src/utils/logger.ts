import type SemVer from "semver"
import { config } from "@dotenvx/dotenvx"

import { blue, green, yellow, red, cyan, magenta, gray, bold } from "colorette"

// Load the .always-up-to-date configuration file
config({
  path: ".always-up-to-date",
  debug: false,
  quiet: true,
  ignore: ["MISSING_ENV_FILE"],
  strict: false,
})

/**
 * Reusable Logger class with emojis and colors for consistent output across package managers
 */
class Logger {
  private quiet: boolean = Boolean(process.env.SILENT === "true")

  setQuiet(quiet: boolean): void {
    this.quiet = quiet
  }

  /**
   * Standard info message
   */
  info(message: string): void {
    if (!this.quiet) {
      console.log(`${blue("ℹ️")} ${message}`)
    }
  }

  /**
   * Success message with green color
   */
  success(message: string): void {
    if (!this.quiet) {
      console.log(`${green("✅")} ${green(message)}`)
    }
  }

  /**
   * Warning message with yellow color
   */
  warn(message: string): void {
    if (!this.quiet) {
      console.log(`${yellow("⚠️")} ${yellow(message)}`)
    }
  }

  /**
   * Error message with red color
   */
  error(message: string): void {
    if (!this.quiet) {
      console.log(`${red("❌")} ${red(message)}`)
    }
  }

  /**
   * Package manager operation message
   */
  packageOperation(message: string): void {
    if (!this.quiet) {
      console.log(`${cyan("📦")} ${cyan(message)}`)
    }
  }

  /**
   * Command execution message
   */
  command(command: string): void {
    if (!this.quiet) {
      console.log(`${magenta("⚡")} ${gray(`Running command "${command}"...`)}`)
    }
  }

  /**
   * Workspace detection message
   */
  workspace(manager: string): void {
    if (!this.quiet) {
      console.log(
        `${blue("🏢")} ${blue(`Detected ${manager} workspace file. Treating this project as a ${manager} workspace.`)}`,
      )
    }
  }

  /**
   * All packages up to date message
   */
  allUpToDate(): void {
    if (!this.quiet) {
      console.log(`${green("🎉")} ${green("All packages are up to date.")}`)
    }
  }

  /**
   * Outdated packages header
   */
  outdatedHeader(): void {
    if (!this.quiet) {
      console.log(
        `${yellow("📈")} ${bold("Some outdated packaged were found!")}`,
      )
    }
  }

  /**
   * Individual outdated package with version comparison
   */
  outdatedPackage(packageName: string, current: string, latest: string): void {
    if (!this.quiet) {
      const arrow = gray("→")
      console.log(
        `  ${yellow("📋")} ${bold(packageName)}: ${red(current)} ${arrow} ${green(latest)}`,
      )
    }
  }

  /**
   * Package group header (e.g., "@babel packages:", "Other packages:")
   */
  packageGroupHeader(groupName: string): void {
    if (!this.quiet) {
      const displayName =
        groupName === "unscoped" ? "Other packages" : `${groupName} packages`
      console.log(`\n${cyan("🏷️")}  ${bold(displayName)}:`)
    }
  }

  /**
   * Individual outdated package within a group (with extra indentation)
   */
  outdatedPackageInGroup(
    packageName: string,
    current: string,
    latest: string,
  ): void {
    if (!this.quiet) {
      const arrow = gray("→")
      console.log(
        `  ${yellow("📋")} ${bold(packageName)}: ${red(current)} ${arrow} ${green(latest)}`,
      )
    }
  }

  /**
   * Updating packages header
   */
  updatingHeader(): void {
    if (!this.quiet) {
      console.log(`${blue("🔄")} ${bold("Updating packages...")}`)
    }
  }

  /**
   * Updating package message
   */
  updatingPackage(packageName: string, current: string, latest: string): void {
    if (!this.quiet) {
      const arrow = gray("→")
      console.log(
        `  ${yellow("🔄")} ${bold(packageName)}: ${red(current)} ${arrow} ${green(latest)} (updating...)`,
      )
    }
  }

  /**
   * Skipping package update message
   */
  skippingPackage(
    packageName: string,
    current: string,
    latest: string,
    updateType: SemVer.ReleaseType | null,
  ): void {
    if (!this.quiet) {
      const arrow = gray("→")
      console.log(
        `  ${yellow("⏭️")}  ${bold(packageName)}: ${red(current)} ${arrow} ${green(latest)} (${updateType} update skipped)`,
      )
    }
  }

  /**
   * Starting operation message
   */
  starting(operation: string, manager: string): void {
    if (!this.quiet) {
      console.log(`${blue("🚀")} ${blue(`${operation} with ${manager}...`)}`)
    }
  }

  /**
   * Clean message without emoji (for raw output)
   */
  clean(message: string): void {
    if (!this.quiet) {
      console.log(message)
    }
  }

  /**
   * Debug message with gray color
   */
  debug(message: string): void {
    if (!this.quiet) {
      console.log(`${gray("🔍")} ${gray(message)}`)
    }
  }
}

const logger = new Logger()

export default logger
