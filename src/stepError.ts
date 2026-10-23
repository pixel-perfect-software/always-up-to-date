/** Pipeline steps a command can fail in (docs/roadmap.md, principle 4). */
export type PipelineStep = 'detect' | 'discover' | 'apply'

/**
 * An error tagged with the step it happened in, so the command layer can say
 * what broke. `manifestWritten` is true when package.json (or a catalog) was
 * already rewritten before the failure, leaving it ahead of the lockfile.
 */
export class StepError extends Error {
  readonly step: PipelineStep
  readonly manifestWritten: boolean

  constructor(
    step: PipelineStep,
    message: string,
    options: { manifestWritten?: boolean; cause?: unknown } = {},
  ) {
    super(message, { cause: options.cause })
    this.name = 'StepError'
    this.step = step
    this.manifestWritten = options.manifestWritten ?? false
  }
}
