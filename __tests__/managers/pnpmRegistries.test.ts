jest.mock('@/utils/logger')

import {
  pnpmRegistrySettings,
  substitutePnpm,
} from '@/managers/pnpm/registries'

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

  it('reads the flat legacy shape written as one-line flow', () => {
    const yaml = `registries: { default: ${A}, "@acme": ${B}, '@corp': "${B}" } # routes\n`
    expect(pnpmRegistrySettings(yaml)).toEqual({
      registry: A,
      scopes: { '@acme': B, '@corp': B },
    })
  })

  it('ignores a nested flow mapping', () => {
    const yaml = `registries: { ${A}: { scopes: ["@acme"] } }\n`
    expect(pnpmRegistrySettings(yaml)).toEqual({ scopes: {} })
  })

  it('is empty without registry settings', () => {
    expect(pnpmRegistrySettings('saveExact: true\n')).toEqual({ scopes: {} })
    expect(pnpmRegistrySettings('')).toEqual({ scopes: {} })
  })
})

describe('pnpmRegistrySettings with env (a global file)', () => {
  it('expands ${VAR} and ${VAR:-default} in the values', () => {
    const settings = pnpmRegistrySettings(
      'registry: ${HOST}\nregistries:\n  "@acme": ${UNSET:-http://127.0.0.1:4002/}\n',
      { env: { HOST: A } },
    )
    expect(settings).toEqual({ registry: A, scopes: { '@acme': B } })
  })

  it('keeps ignoring ${…} in a project file, which is read without env', () => {
    expect(pnpmRegistrySettings('registry: ${HOST}\n').registry).toBeUndefined()
  })
})

describe('substitutePnpm', () => {
  it('expands ${VAR}, uses the default of ${VAR:-default} when unset or empty, and turns an unset ${VAR} into an empty string', () => {
    const env = { SET: 'v', EMPTY: '' }
    expect(substitutePnpm('${SET}', env)).toBe('v')
    expect(substitutePnpm('${UNSET:-d}', env)).toBe('d')
    expect(substitutePnpm('${SET:-d}', env)).toBe('v')
    // pnpm 12.15.0 and 12.14.0 took the default for a set but empty variable (p34e, p34f).
    expect(substitutePnpm('${EMPTY:-d}', env)).toBe('d')
    expect(substitutePnpm('${EMPTY}', env)).toBe('')
    expect(substitutePnpm('a${UNSET}b', env)).toBe('ab')
  })
})
