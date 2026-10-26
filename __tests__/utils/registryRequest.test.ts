import type { RegistryConfig, RegistryCredentials } from '@/types'
import {
  authorizationFor,
  credentialPrefixes,
  credentialsFor,
  isRetryableError,
  isRetryableStatus,
  packumentUrl,
  RETRY_MAX_MS,
  registryFor,
  retryDelay,
} from '@/utils/registryRequest'

const config = (overrides: Partial<RegistryConfig> = {}): RegistryConfig => ({
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

describe('packumentUrl', () => {
  it('joins the registry path and name', () => {
    expect(packumentUrl('ms', 'https://registry.npmjs.org/')).toBe(
      'https://registry.npmjs.org/ms',
    )
    expect(packumentUrl('ms', 'https://host.test/npm/repo')).toBe(
      'https://host.test/npm/repo/ms',
    )
  })

  it('escapes only the slash of a scoped name', () => {
    expect(packumentUrl('@corp/pkg', ' https://host.test/ ')).toBe(
      'https://host.test/@corp%2fpkg',
    )
  })
})

describe('registryFor', () => {
  const scoped = config({
    registry: 'https://default.test/',
    scopedRegistries: { '@corp': 'https://corp.test/' },
  })

  it('uses the scope registry for a scoped name', () => {
    expect(registryFor('@corp/pkg', scoped)).toBe('https://corp.test/')
  })

  it('uses the default for an unscoped name or an unknown scope', () => {
    expect(registryFor('ms', scoped)).toBe('https://default.test/')
    expect(registryFor('@other/pkg', scoped)).toBe('https://default.test/')
  })
})

describe('credentialsFor', () => {
  const registry = 'https://host.test/npm/repo/'
  const url = new URL('https://host.test/npm/repo/pkg')

  it('walks the prefixes from the longest', () => {
    expect(credentialPrefixes(url)).toEqual([
      '//host.test/npm/repo/pkg',
      '//host.test/npm/repo/',
      '//host.test/npm/repo',
      '//host.test/npm/',
      '//host.test/npm',
      '//host.test/',
      '//host.test',
    ])
  })

  it('sends the longest prefix that holds a credential', () => {
    const found = credentialsFor(url, registry, {
      '//host.test/': { authToken: 'HOST' },
      '//host.test/npm/repo/': { authToken: 'REPO' },
    })
    expect(found?.authToken).toBe('REPO')
  })

  it('counts the port', () => {
    const withPort = new URL('http://127.0.0.1:4000/pkg')
    expect(
      credentialsFor(withPort, 'http://127.0.0.1:4000/', {
        '//127.0.0.1:5000/': { authToken: 'OTHER' },
      }),
    ).toBeUndefined()
    expect(
      credentialsFor(withPort, 'http://127.0.0.1:4000/', {
        '//127.0.0.1:4000/': { authToken: 'THIS' },
      })?.authToken,
    ).toBe('THIS')
  })

  it('lets a deeper cert and key beat a host token, taking every field from that prefix', () => {
    const found = credentialsFor(url, registry, {
      '//host.test/': { authToken: 'HOST' },
      '//host.test/npm/repo/': { certfile: '/c.pem', keyfile: '/k.pem' },
    })
    expect(found).toEqual({ certfile: '/c.pem', keyfile: '/k.pem' })
    expect(authorizationFor(found)).toBeUndefined()
  })

  it('does not count a lone username, or a cert without its key', () => {
    expect(
      credentialsFor(url, registry, {
        '//host.test/npm/repo/': { username: 'user', certfile: '/c.pem' },
        '//host.test/': { authToken: 'HOST' },
      })?.authToken,
    ).toBe('HOST')
  })

  it("falls back to the registry's credentials for another path on its host", () => {
    const tarball = new URL('https://host.test/other/pkg.tgz')
    expect(
      credentialsFor(tarball, registry, {
        '//host.test/npm/repo/': { authToken: 'REPO' },
      })?.authToken,
    ).toBe('REPO')
  })

  it('does not fall back for another host', () => {
    expect(
      credentialsFor(new URL('https://cdn.test/pkg'), registry, {
        '//host.test/npm/repo/': { authToken: 'REPO' },
      }),
    ).toBeUndefined()
  })
})

describe('authorizationFor', () => {
  const header = (c: RegistryCredentials) => authorizationFor(c)

  it('sends a token as Bearer', () => {
    expect(header({ authToken: 'TOK', auth: 'dXNlcjpwYXNz' })).toBe(
      'Bearer TOK',
    )
  })

  it('sends _auth as Basic, unchanged', () => {
    expect(header({ auth: 'dXNlcjpwYXNz' })).toBe('Basic dXNlcjpwYXNz')
  })

  it('builds Basic from a username and the decoded _password', () => {
    const password = Buffer.from('pass').toString('base64')
    expect(header({ username: 'user', password })).toBe(
      `Basic ${Buffer.from('user:pass').toString('base64')}`,
    )
  })

  it('sends nothing without credentials', () => {
    expect(authorizationFor(undefined)).toBeUndefined()
    expect(header({ username: 'user' })).toBeUndefined()
  })
})

describe('retries', () => {
  it('backs off exponentially, capped', () => {
    expect(retryDelay(0, undefined, 0)).toBe(100)
    expect(retryDelay(1, undefined, 0)).toBe(200)
    expect(retryDelay(2, undefined, 0)).toBe(400)
    expect(retryDelay(10, undefined, 0)).toBe(RETRY_MAX_MS)
  })

  it('honors Retry-After in seconds', () => {
    expect(retryDelay(0, '1', 0)).toBe(1000)
    expect(retryDelay(0, '0', 0)).toBe(0)
  })

  it('honors Retry-After as an HTTP date, floored at zero', () => {
    const now = Date.parse('2026-01-01T00:00:00Z')
    expect(retryDelay(0, 'Thu, 01 Jan 2026 00:00:01 GMT', now)).toBe(1000)
    expect(retryDelay(0, 'Wed, 31 Dec 2025 23:00:00 GMT', now)).toBe(0)
  })

  it('stops when Retry-After is over the cap', () => {
    expect(retryDelay(0, '120', 0)).toBeUndefined()
  })

  it('falls back to backoff for an unreadable Retry-After', () => {
    expect(retryDelay(0, 'soon', 0)).toBe(100)
  })

  it('retries throttling and server errors only', () => {
    for (const status of [408, 420, 429, 500, 503]) {
      expect(isRetryableStatus(status)).toBe(true)
    }
    for (const status of [301, 400, 401, 404]) {
      expect(isRetryableStatus(status)).toBe(false)
    }
  })

  it('retries connection resets, refusals and timeouts, not DNS failures', () => {
    for (const code of ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT']) {
      expect(isRetryableError({ code })).toBe(true)
    }
    expect(isRetryableError({ code: 'ENOTFOUND' })).toBe(false)
    expect(isRetryableError(new Error('x'))).toBe(false)
    expect(isRetryableError(undefined)).toBe(false)
  })
})
