#!/usr/bin/env node

import { ConfigError } from './utils/config'

export const main = async () => {
  try {
    // Loaded here, not at the top: loading the CLI reads the config file, and
    // a bad config must reach this catch rather than crash with a stack trace.
    const { default: cli } = await import('./cli')
    await cli()
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(`autd: ${error.message}`)
    } else {
      console.error('An error occurred:', error)
    }
    process.exit(1)
  }
}

// Execute if run directly
if (require.main === module) main()
