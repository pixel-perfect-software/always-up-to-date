import fs from 'fs'
import os from 'os'
import path from 'path'
import type { RegistryConfig } from '@/types'
import type { NpmrcSources } from '@/utils/npmrcLoader'

/*
 * Helpers for tests that build files on disk. Importing this module registers
 * one root-level `afterEach` in the importing test file, which removes every
 * directory `tempDir` made during the test, so a test never cleans up itself.
 */

const created: string[] = []

afterEach(() => {
  for (const dir of created.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

/**
 * A new empty directory under the OS temp folder, named `<prefix>XXXXXX` and
 * removed after the current test. Call it in `beforeEach` or in the test.
 * `real` resolves symlinks (macOS's `/var` is `/private/var`), for a test that
 * compares the path with one the code under test resolved.
 */
export const tempDir = (prefix: string, { real = false } = {}): string => {
  const made = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  created.push(made)
  return real ? fs.realpathSync(made) : made
}

/**
 * Writes `content` to the absolute path `file`, making its parent directories.
 * An object is written as compact JSON.
 */
export const write = (file: string, content: string | object = ''): void => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(
    file,
    typeof content === 'string' ? content : JSON.stringify(content),
  )
}

/**
 * The `.npmrc` sources of a test machine rooted at `root`: home `<root>/home`,
 * and a Node install under `<root>/prefix`, so the real install's `etc/npmrc`
 * cannot leak in. By default the layout is Node's own (`node.exe` in the
 * prefix on Windows, `<prefix>/bin/node` elsewhere); a test that never ran on
 * Windows' layout passes `execPath`.
 */
export const npmrcSources = (
  root: string,
  env: NodeJS.ProcessEnv = {},
  overrides: Partial<NpmrcSources> = {},
): NpmrcSources => ({
  env,
  home: path.join(root, 'home'),
  execPath:
    process.platform === 'win32'
      ? path.join(root, 'prefix', 'node.exe')
      : path.join(root, 'prefix', 'bin', 'node'),
  platform: process.platform,
  ...overrides,
})

/**
 * A `RegistryConfig` with npm's own defaults (retries 2, a 300 s timeout) for
 * the public registry; `overrides` replace any field.
 */
export const registryConfig = (
  overrides: Partial<RegistryConfig> = {},
): RegistryConfig => ({
  registry: 'https://registry.npmjs.org/',
  scopedRegistries: {},
  credentials: {},
  strictSSL: true,
  proxy: {},
  fetchRetries: 2,
  fetchTimeout: 300_000,
  maxSockets: 15,
  ...overrides,
})

/**
 * A `RegistryConfig` for a local test registry at `registry`: no retries and
 * a 5 s timeout, so a failing request ends the test quickly.
 */
export const localRegistryConfig = (
  registry: string,
  overrides: Partial<RegistryConfig> = {},
): RegistryConfig =>
  registryConfig({
    registry,
    fetchRetries: 0,
    fetchTimeout: 5000,
    ...overrides,
  })
