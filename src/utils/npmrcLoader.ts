import fs from 'fs'
import ini from 'ini'
import os from 'os'
import path from 'path'
import type { RegistryConfig } from '@/types'

const ENV_VAR_PATTERN = /\$\{([^}]+)\}/g

const substituteEnvVars = (value: string): string =>
  value.replace(ENV_VAR_PATTERN, (_, name) => process.env[name] ?? '')

const readNpmrc = (filePath: string): Record<string, unknown> => {
  try {
    const content = fs.readFileSync(filePath, 'utf8')
    return ini.parse(content) as Record<string, unknown>
  } catch {
    return {}
  }
}

const collectEnvOverrides = (): Record<string, string> => {
  const overrides: Record<string, string> = {}
  for (const [envKey, envValue] of Object.entries(process.env)) {
    if (!envValue) continue
    if (!envKey.startsWith('NPM_CONFIG_')) continue
    const key = envKey
      .slice('NPM_CONFIG_'.length)
      .toLowerCase()
      .replace(/_/g, '-')
    overrides[key] = envValue
  }
  return overrides
}

const stringValue = (value: unknown): string | undefined =>
  typeof value === 'string' ? substituteEnvVars(value) : undefined

const boolValue = (value: unknown): boolean | undefined => {
  if (typeof value === 'boolean') return value
  const str = stringValue(value)
  if (str === undefined) return undefined
  if (str === 'true') return true
  if (str === 'false') return false
  return undefined
}

const stripTrailingSlash = (url: string): string =>
  url.endsWith('/') ? url.slice(0, -1) : url

const hostFromAuthKey = (key: string): string | undefined => {
  // Auth keys look like "//registry.npmjs.org/:_authToken" or
  // "//registry.npmjs.org/some/path/:_authToken". Strip the
  // leading "//" and trailing ":_authToken" to get the host+path.
  const match = key.match(/^\/\/(.+):_authToken$/)
  return match ? match[1] : undefined
}

/**
 * Loads .npmrc-style config the way npm/pnpm/yarn-classic/bun do for the
 * registry/auth fields we care about. Precedence (high → low): NPM_CONFIG_*
 * env vars → project .npmrc → user ~/.npmrc. Yarn berry's .yarnrc.yml and
 * Bun's bunfig.toml are not yet read.
 */
export const loadRegistryConfig = (cwd: string): RegistryConfig => {
  const projectConfig = readNpmrc(path.join(cwd, '.npmrc'))
  const userConfig = readNpmrc(path.join(os.homedir(), '.npmrc'))
  const envConfig = collectEnvOverrides()

  const merged: Record<string, unknown> = {
    ...userConfig,
    ...projectConfig,
    ...envConfig,
  }

  const registry = stringValue(merged.registry) ?? 'https://registry.npmjs.org/'

  const scopedRegistries: Record<string, string> = {}
  const authTokens: Record<string, string> = {}

  for (const [key, value] of Object.entries(merged)) {
    if (typeof value !== 'string') continue
    const resolved = substituteEnvVars(value)

    if (/^@[^:]+:registry$/.test(key)) {
      const scope = key.slice(0, key.indexOf(':'))
      scopedRegistries[scope] = resolved
      continue
    }

    if (key.startsWith('//') && key.endsWith(':_authToken')) {
      const host = hostFromAuthKey(key)
      if (host) authTokens[stripTrailingSlash(host)] = resolved
    }
  }

  return {
    registry,
    scopedRegistries,
    authTokens,
    alwaysAuth: boolValue(merged['always-auth']),
    strictSSL: boolValue(merged['strict-ssl']),
    ca: stringValue(merged.ca),
    cafile: stringValue(merged.cafile),
  }
}
