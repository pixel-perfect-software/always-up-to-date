import { StepError } from '@/stepError'
import {
  type ErrorDocument,
  errorDocument,
  printJson,
} from '@/utils/jsonDocument'
import logger from '@/utils/logger'
import { scrub } from '@/utils/redaction'

/**
 * Reports a failed command once and sets exit code 1. With `--json`, stdout
 * gets the error document (`version`, `autd`, `command`, and `error` with
 * `step`, `message`, `manifestWritten`; `step` is null outside a pipeline
 * step), never an empty result that would read as "nothing to update".
 */
const reportFailure = (
  error: unknown,
  { json, command }: { json?: boolean; command: ErrorDocument['command'] },
): void => {
  const step = error instanceof StepError ? error.step : undefined
  const manifestWritten = error instanceof StepError && error.manifestWritten
  const message = scrub(error instanceof Error ? error.message : String(error))

  process.exitCode = 1

  if (json) {
    printJson(
      errorDocument(command, { step: step ?? null, message, manifestWritten }),
    )
    return
  }

  const refusal = error instanceof StepError && error.refusal
  logger.error(step && !refusal ? `Failed during ${step}: ${message}` : message)
  if (manifestWritten) {
    logger.warn(
      'package.json was already rewritten when the package manager failed. Check it against the lockfile (git diff) before committing.',
      { always: true },
    )
  }
}

export default reportFailure
