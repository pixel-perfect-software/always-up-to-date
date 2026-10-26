jest.mock('@/utils/logger')

import {
  applyPnpmRegistrySettings,
  pnpmRegistrySettings,
} from '@/managers/pnpm/registries'
import type { RegistryConfig } from '@/types'

const A = 'http://127.0.0.1:4001/'
const B = 'http://127.0.0.1:4002/'

describe('pnpmRegistrySettings', () => {
  it('reads a top-level registry', () => {
    expect(pnpmRegistrySettings(`registry: ${B}\n`)).toEqual({
      registry: B,
      scopes: {},
    })
  })

  it('reads the legacy map: default and "@scope" keys', () => {
    const yaml = `registries:\n  default: ${A}\n  "@acme": ${B}\n  '@corp': ${B}\n`
    expect(pnpmRegistrySettings(yaml)).toEqual({
      registry: A,
      scopes: { '@acme': B, '@corp': B },
    })
  })

  it('ignores a "@" key in the legacy map', () => {
    expect(pnpmRegistrySettings(`registries:\n  "@": ${B}\n`)).toEqual({
      scopes: {},
    })
  })

  it('reads URL-keyed entries with flow and block scopes, "@" meaning the default', () => {
    const yaml = [
      'registries:',
      `  ${A}:`,
      '    scopes: ["@acme", \'@corp\']',
      `  "${B}":`,
      '    scopes:',
      '      - "@"',
      '      - "@other" # comment',
      '',
    ].join('\n')
    expect(pnpmRegistrySettings(yaml)).toEqual({
      registry: B,
      scopes: { '@acme': A, '@corp': A, '@other': B },
    })
  })

  it('reads an inline flow entry after a URL key', () => {
    const yaml = `registries:\n  ${A}: { scopes: ["@acme"] }\n`
    expect(pnpmRegistrySettings(yaml).scopes).toEqual({ '@acme': A })
  })

  it('lets the top-level registry beat a registries default', () => {
    const yaml = `registry: ${A}\nregistries:\n  default: ${B}\n`
    expect(pnpmRegistrySettings(yaml).registry).toBe(A)
  })

  it('falls back to the registries default when the top-level value is unusable', () => {
    const yaml = `registry: http://127.0.0.1:\${PORT}/\nregistries:\n  default: ${B}\n`
    expect(pnpmRegistrySettings(yaml).registry).toBe(B)
  })

  it('ignores values holding ${...}', () => {
    const yaml = `registries:\n  "@acme": http://h:\${PORT}/\n  http://h:\${PORT}/:\n    scopes: ["@corp"]\n`
    expect(pnpmRegistrySettings(yaml)).toEqual({ scopes: {} })
  })

  it('ignores entries with another ecosystem and values that are not http(s)', () => {
    const yaml = [
      'registries:',
      `  ${A}:`,
      '    ecosystem: pypi',
      '    scopes: ["@py"]',
      `  ${B}: { ecosystem: cargo, scopes: ["@rs"] }`,
      '  "@bad": ftp://example.test/',
      '',
    ].join('\n')
    expect(pnpmRegistrySettings(yaml)).toEqual({ scopes: {} })
  })

  it('keeps an entry whose ecosystem is npm', () => {
    const yaml = `registries:\n  ${A}:\n    ecosystem: npm\n    scopes: ["@acme"]\n`
    expect(pnpmRegistrySettings(yaml).scopes).toEqual({ '@acme': A })
  })

  it('handles CRLF, comments and the end of the block', () => {
    const yaml = [
      '# settings',
      'registries: # routes',
      '  # the default',
      `  default: "${A}" # main`,
      '',
      `  "@acme": ${B}`,
      'saveExact: true',
      `  "@after": ${A}`,
      '',
    ].join('\r\n')
    expect(pnpmRegistrySettings(yaml)).toEqual({
      registry: A,
      scopes: { '@acme': B },
    })
  })

  it('is empty without registry settings', () => {
    expect(pnpmRegistrySettings('saveExact: true\n')).toEqual({ scopes: {} })
    expect(pnpmRegistrySettings('')).toEqual({ scopes: {} })
  })
})

describe('applyPnpmRegistrySettings', () => {
  const base: RegistryConfig = {
    registry: 'https://registry.npmjs.org/',
    scopedRegistries: { '@acme': A, '@keep': A },
    credentials: { '//127.0.0.1:4002/': { authToken: 'T' } },
    strictSSL: true,
    proxy: {},
    fetchRetries: 2,
    fetchTimeout: 300_000,
    maxSockets: 15,
  }

  it('puts the yaml over the .npmrc view per key and keeps its credentials', () => {
    const config = applyPnpmRegistrySettings(
      base,
      `registry: ${B}\nregistries:\n  "@acme": ${B}\n`,
    )
    expect(config).toEqual({
      ...base,
      registry: B,
      scopedRegistries: { '@acme': B, '@keep': A },
    })
  })

  it('returns the .npmrc view when the yaml routes nothing', () => {
    expect(applyPnpmRegistrySettings(base, 'saveExact: true\n')).toEqual(base)
  })
})
