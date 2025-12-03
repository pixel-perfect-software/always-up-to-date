#!/usr/bin/env node

import cli from "./cli"

const main = async () => {
  try {
    await cli()
  } catch (error) {
    console.error("An error occurred:", error)
    process.exit(1)
  }
}

// Execute if run directly
if (require.main === module) main()
