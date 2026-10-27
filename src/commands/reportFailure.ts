import { StepError } from '@/stepError'
import logger from '@/utils/logger'
import { scrub } from '@/utils/redaction'

/**
 * Reports a failed command once and sets exit code 1. With `--json`, stdout
 * gets `{ "error": { step, message, manifestWritten } }`, never an empty
 * result that would read as "nothing to update".
 */
const reportFailure = (error: unknown, json?: boolean): void => {
  const step = error instanceof StepError ? error.step : undefined
  const manifestWritten = error instanceof StepError && error.manifestWritten
  const message = scrub(error instanceof Error ? error.message : String(error))

  process.exitCode = 1

  if (json) {
    console.log(
      JSON.stringify({ error: { step, message, manifestWritten } }, null, 2),
    )
    return
  }

  logger.error(step ? `Failed during ${step}: ${message}` : message)
  if (manifestWritten) {
    logger.warn(
      'package.json was already rewritten when the package manager failed. Check it against the lockfile (git diff) before committing.',
    )
  }
}

export default reportFailure
