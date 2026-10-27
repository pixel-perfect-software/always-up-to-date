// Global test setup for Always Up To Date

// Suppress console output during tests unless DEBUG is set
if (!process.env.DEBUG) {
  const noop = () => ({})
  console.log = noop
  console.error = noop
  console.warn = noop
}

// Tests never read or write the developer's cache folder; the ones that
// exercise the cache pass their own directory.
process.env.AUTD_NO_CACHE = '1'
