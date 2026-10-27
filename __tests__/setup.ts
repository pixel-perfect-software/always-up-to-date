import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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

// Tests never read the developer's or CI's own registry configuration: the
// loaders take their files from HOME, XDG_CONFIG_HOME, PREFIX and the
// userconfig variables, and their routes from the *_CONFIG_* and YARN_REGISTRY
// variables. Every test file starts in an empty home with none of them set;
// a test that needs one sets it (and restores it) itself.
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-test-home-'))
  for (const key of Object.keys(process.env)) {
    if (/^(npm|pnpm|bun|yarn)_config_/i.test(key)) delete process.env[key]
  }
  for (const key of [
    'XDG_CONFIG_HOME',
    'LOCALAPPDATA',
    'APPDATA',
    'USERPROFILE',
    'YARN_REGISTRY',
    'yarn_registry',
  ]) {
    delete process.env[key]
  }
  process.env.HOME = home
  process.env.PREFIX = home
  process.on('exit', () => fs.rmSync(home, { recursive: true, force: true }))
}
