#!/usr/bin/env node

export const main = async () => {
  try {
    const { default: cli } = await import('./cli')
    await cli()
  } catch (error) {
    console.error('An error occurred:', error)
    process.exit(1)
  }
}

// Execute if run directly
if (require.main === module) main()
