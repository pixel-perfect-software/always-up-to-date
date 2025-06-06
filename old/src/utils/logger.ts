import fs from "fs"
import path from "path"
import { createColors } from "colorette"
import { AlwaysUpToDateError } from "./errors"

// Force enable colors
const colorette = createColors({ useColor: true })

/**
 * Logger class for consistent logging across the application
 */
class Logger {
  private logLevel: string
  private logLevels: Record<string, number>
  private colorMap: Record<string, (text: string) => string>
  private quiet: boolean = false
  private lastMessage: string = ""
  private messageCount: Map<string, number> = new Map()

  constructor(logLevel = "info") {
    this.logLevel = logLevel
    this.logLevels = {
      error: 0,
      warn: 1,
      info: 2,
      debug: 3,
    }
    this.colorMap = {
      error: colorette.red,
      warn: colorette.yellow,
      info: colorette.green,
      debug: colorette.blue,
    }
  }

  setLevel(level: string): void {
    this.logLevel = level
  }

  setQuiet(quiet: boolean): void {
    this.quiet = quiet
  }

  /**
   * Log a message only if it hasn't been logged recently (deduplication)
   */
  logOnce(message: any, level = "info"): void {
    const messageKey = `${level}:${message}`
    const count = this.messageCount.get(messageKey) || 0

    if (count === 0) {
      this.log(message, level)
      this.messageCount.set(messageKey, 1)

      // Clean up old messages after some time
      setTimeout(() => {
        this.messageCount.delete(messageKey)
      }, 30000) // 30 seconds
    }
  }

  /**
   * Log a clean message without timestamp and level for user-facing output
   */
  clean(message: string): void {
    if (!this.quiet) {
      console.log(message)
    }
  }

  /**
   * Log a status message with icon
   */
  status(message: string, icon = "ℹ"): void {
    if (!this.quiet) {
      console.log(`${colorette.blue(icon)} ${message}`)
    }
  }

  /**
   * Log a success message
   */
  success(message: string): void {
    if (!this.quiet) {
      console.log(`${colorette.green("✅")} ${message}`)
    }
  }

  /**
   * Log a progress message that can be updated
   */
  progress(message: string): void {
    if (!this.quiet && this.logLevel !== "debug") {
      // Only show progress in non-debug mode to avoid clutter
      console.log(`${colorette.yellow("⏳")} ${message}`)
    }
  }

  log(message: any, level = "info"): void {
    if (this.logLevels[level] <= this.logLevels[this.logLevel]) {
      const timestamp = new Date().toISOString()
      const colorFn = this.colorMap[level] || ((text: string) => text)
      const formattedLevel = colorFn(colorette.bold(`[${level.toUpperCase()}]`))

      let formattedMessage = message
      if (message instanceof Error) {
        formattedMessage = this.formatError(message)
      } else if (typeof message === "object") {
        formattedMessage = JSON.stringify(message, null, 2)
      }

      console.log(
        `${colorette.gray(
          `[${timestamp}]`,
        )} ${formattedLevel}: ${formattedMessage}`,
      )
    }
  }

  private formatError(error: Error): string {
    if (error instanceof AlwaysUpToDateError) {
      let message = `${error.message}`
      if (error.code) {
        message += ` [${error.code}]`
      }
      if (error.originalError && this.logLevel === "debug") {
        message += `\nOriginal error: ${error.originalError.message}`
        if (error.originalError.stack) {
          message += `\nStack: ${error.originalError.stack}`
        }
      }
      return message
    }

    return this.logLevel === "debug" && error.stack
      ? `${error.message}\nStack: ${error.stack}`
      : error.message
  }

  error(message: any): void {
    this.log(message, "error")
  }

  warn(message: any): void {
    this.log(message, "warn")
  }

  info(message: any): void {
    this.log(message, "info")
  }

  debug(message: any): void {
    this.log(message, "debug")
  }

  static logToFile(message: any, level = "info"): void {
    const logFilePath = path.join(process.cwd(), "always-up-to-date.log")
    const timestamp = new Date().toISOString()
    const logMessage = `[${timestamp}] [${level.toUpperCase()}]: ${message}\n`

    fs.appendFile(logFilePath, logMessage, (err) => {
      if (err) {
        console.error("Failed to write to log file:", err)
      }
    })
  }
}

// Export a singleton instance for use across the application
export const logger = new Logger()

// For backwards compatibility with existing code
export const log = (message: any, level = "info"): void => {
  logger.log(message, level)
}

export default Logger
