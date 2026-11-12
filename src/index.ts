#!/usr/bin/env node

export const main = async () => {
  try {
    const { default: cli } = await import('./cli')
    await cli()
  } catch (error) {
    // The stack stays: a failure to start is a bug, and the stack is what a
    // report of it needs. Loaded here, not at the top: the startup path stays
    // what it is, and a failure to start is the only run that needs it.
    const detail =
      error instanceof Error && error.stack ? error.stack : String(error)
    const { scrub } = await import('./utils/redaction')
    console.error(scrub(`An error occurred: ${detail}`))
    process.exit(1)
  }
}

// Execute if run directly
if (require.main === module) main()
