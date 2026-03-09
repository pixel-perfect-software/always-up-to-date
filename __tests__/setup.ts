// Global test setup for Always Up To Date

// Suppress console output during tests unless DEBUG is set
if (!process.env.DEBUG) {
  const noop = () => ({})
  console.log = noop
  console.error = noop
  console.warn = noop
}
