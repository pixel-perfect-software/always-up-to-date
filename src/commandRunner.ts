import { execAsync, logger } from "@/utils"

import type { SupportedPackageManager } from "@/types"

interface ExecError extends Error {
  stdout?: string
  stderr?: string
}

class CommandRunner {
  public runCommand = async (
    packageManager: SupportedPackageManager,
    command: string,
    cwd: string,
  ): Promise<string | undefined> => {
    logger.command(`${packageManager} ${command}`)

    try {
      const { stdout } = await execAsync(`${packageManager} ${command}`, {
        cwd,
        encoding: "utf8",
      })
      return stdout
    } catch (error) {
      const execError = error as ExecError

      if (
        execError.stdout &&
        (!execError.stderr || execError.stderr.length === 0)
      ) {
        return execError.stdout
      }

      if (execError.stderr) {
        logger.error(`Command failed: ${execError.stderr}`)
        throw new Error(`Command execution failed: ${execError.stderr}`)
      }

      logger.error(`Unknown error occurred: ${execError.message}`)
      throw new Error(
        `An unknown error occurred while running the command: ${execError.message}`,
      )
    }
  }
}

export default CommandRunner
