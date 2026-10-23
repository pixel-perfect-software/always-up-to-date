import { type PipelineStep, StepError } from '@/stepError'
import type { SupportedPackageManager } from '@/types'
import { logger, runProcess } from '@/utils'

interface ExecError extends Error {
  code?: number | string
  stdout?: string
  stderr?: string
}

export interface CommandOutput {
  exitCode: number
  stdout: string
}

/**
 * Decides whether a finished command did its job. stderr is not part of the
 * decision: managers print warnings there on success (yarn v1 under Node 24
 * always prints a DEP0169 deprecation warning).
 */
export type SuccessCheck = (output: CommandOutput) => boolean

const exitedZero: SuccessCheck = ({ exitCode }) => exitCode === 0

class CommandRunner {
  public runCommand = async (
    packageManager: SupportedPackageManager,
    args: string[],
    cwd: string,
    isSuccess: SuccessCheck = exitedZero,
  ): Promise<string> => {
    logger.command(`${packageManager} ${args.join(' ')}`)

    let output: CommandOutput
    let stderr: string

    try {
      const result = await runProcess(packageManager, args, { cwd })
      output = { exitCode: 0, stdout: result.stdout }
      stderr = result.stderr
    } catch (error) {
      const execError = error as ExecError

      // No numeric exit code: the process could not start or was killed.
      if (typeof execError.code !== 'number') {
        throw new Error(
          `An unknown error occurred while running the command: ${execError.message}`,
          { cause: error },
        )
      }

      output = { exitCode: execError.code, stdout: execError.stdout ?? '' }
      stderr = execError.stderr ?? ''
    }

    if (stderr.trim()) {
      logger.debug(`${packageManager} stderr: ${stderr.trim()}`)
    }

    if (isSuccess(output)) return output.stdout

    const detail =
      stderr.trim() || output.stdout.trim() || `exit code ${output.exitCode}`
    throw new Error(`Command execution failed: ${detail}`)
  }

  /**
   * `runCommand` for one pipeline step: a failure is rethrown as a
   * `StepError` so the command layer can report which step broke and whether
   * the manifest was already written.
   */
  public runStep = async (
    step: PipelineStep,
    packageManager: SupportedPackageManager,
    args: string[],
    cwd: string,
    {
      isSuccess,
      manifestWritten = false,
    }: { isSuccess?: SuccessCheck; manifestWritten?: boolean } = {},
  ): Promise<string> => {
    try {
      return await this.runCommand(packageManager, args, cwd, isSuccess)
    } catch (error) {
      throw new StepError(
        step,
        error instanceof Error ? error.message : String(error),
        { manifestWritten, cause: error },
      )
    }
  }
}

export default CommandRunner
