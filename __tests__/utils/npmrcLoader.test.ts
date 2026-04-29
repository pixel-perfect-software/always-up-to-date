import fs from 'fs'
import os from 'os'
import path from 'path'
import { loadRegistryConfig } from '@/utils/npmrcLoader'

jest.mock('fs')
jest.mock('os')

const mockedFs = jest.mocked(fs)
const mockedOs = jest.mocked(os)

interface FileSystem {
  [filePath: string]: string
}

const setupFs = (files: FileSystem) => {
  mockedFs.readFileSync.mockImplementation(((filePath: string) => {
    const content = files[filePath]
    if (content === undefined) {
      const err = new Error(`ENOENT: ${filePath}`) as NodeJS.ErrnoException
      err.code = 'ENOENT'
      throw err
    }
    return content
  }) as never)
}

const HOME = '/home/tester'
const CWD = '/proj'

describe('loadRegistryConfig', () => {
  const ORIGINAL_ENV = process.env

  beforeEach(() => {
    mockedOs.homedir.mockReturnValue(HOME)
    process.env = { ...ORIGINAL_ENV }
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('NPM_CONFIG_')) delete process.env[key]
    }
  })

  afterAll(() => {
    process.env = ORIGINAL_ENV
  })

  it('falls back to the public registry when no .npmrc files exist', () => {
    setupFs({})
    const config = loadRegistryConfig(CWD)
    expect(config.registry).toBe('https://registry.npmjs.org/')
    expect(config.scopedRegistries).toEqual({})
    expect(config.authTokens).toEqual({})
  })

  it('reads registry, scoped registry, and auth from project .npmrc', () => {
    setupFs({
      [path.join(CWD, '.npmrc')]: [
        'registry=https://registry.example.com/',
        '@my-org:registry=https://npm.my-org.dev/',
        '//registry.example.com/:_authToken=abc123',
      ].join('\n'),
    })

    const config = loadRegistryConfig(CWD)

    expect(config.registry).toBe('https://registry.example.com/')
    expect(config.scopedRegistries).toEqual({
      '@my-org': 'https://npm.my-org.dev/',
    })
    expect(config.authTokens).toEqual({
      'registry.example.com': 'abc123',
    })
  })

  it('lets project .npmrc override user ~/.npmrc', () => {
    setupFs({
      [path.join(HOME, '.npmrc')]: 'registry=https://home-default.example/',
      [path.join(CWD, '.npmrc')]: 'registry=https://project-override.example/',
    })

    const config = loadRegistryConfig(CWD)

    expect(config.registry).toBe('https://project-override.example/')
  })

  it('substitutes ${VAR} env references inside .npmrc values', () => {
    process.env.MY_TOKEN = 'super-secret'
    setupFs({
      [path.join(CWD, '.npmrc')]:
        '//registry.example.com/:_authToken=${MY_TOKEN}',
    })

    const config = loadRegistryConfig(CWD)

    expect(config.authTokens['registry.example.com']).toBe('super-secret')
  })

  it('lets NPM_CONFIG_* env vars override file config', () => {
    setupFs({
      [path.join(CWD, '.npmrc')]: 'registry=https://from-file.example/',
    })
    process.env.NPM_CONFIG_REGISTRY = 'https://from-env.example/'

    const config = loadRegistryConfig(CWD)

    expect(config.registry).toBe('https://from-env.example/')
  })

  it('parses always-auth and strict-ssl as booleans', () => {
    setupFs({
      [path.join(CWD, '.npmrc')]: 'always-auth=true\nstrict-ssl=false',
    })

    const config = loadRegistryConfig(CWD)

    expect(config.alwaysAuth).toBe(true)
    expect(config.strictSSL).toBe(false)
  })

  it('handles auth tokens for nested registry paths', () => {
    setupFs({
      [path.join(CWD, '.npmrc')]:
        '//npm.pkg.github.com/scope/:_authToken=ghp_xxx',
    })

    const config = loadRegistryConfig(CWD)

    expect(config.authTokens).toEqual({
      'npm.pkg.github.com/scope': 'ghp_xxx',
    })
  })

  it('ignores keys it does not recognize', () => {
    setupFs({
      [path.join(CWD, '.npmrc')]: [
        'registry=https://r.example/',
        'auto-install-peers=true',
        'save-exact=true',
      ].join('\n'),
    })

    const config = loadRegistryConfig(CWD)

    expect(config.registry).toBe('https://r.example/')
    expect(config.scopedRegistries).toEqual({})
    expect(config.authTokens).toEqual({})
  })
})
