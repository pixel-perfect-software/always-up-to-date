jest.mock('@/utils/logger')

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { PackageLookup, RegistryConfig } from '@/types'
import { createRegistryCache } from '@/utils/registryCache'
import {
  createRegistryClient,
  type RegistryClient,
} from '@/utils/registryClient'
import { createRegistryReader } from '@/utils/registryReader'
import {
  ABBREVIATED_ACCEPT,
  type RegistryEndpoints,
} from '@/utils/registryRequest'
import {
  conditional,
  derive,
  type Handler,
  type Reply,
  registryBody,
  replies,
  startRegistry,
  type TestRegistry,
} from '../fixtures/registry'

const DEPS_DEV_PREFIX = '/v3/systems/npm/packages/'

const configFor = (
  registry: string,
  overrides: Partial<RegistryConfig> = {},
): RegistryConfig => ({
  registry,
  scopedRegistries: {},
  credentials: {},
  strictSSL: true,
  proxy: {},
  fetchRetries: 0,
  fetchTimeout: 5000,
  maxSockets: 15,
  ...overrides,
})

const ok = (name: string): Reply => ({ body: registryBody(name) })
const packument = (name: string): Reply => ({
  body: registryBody(name),
  type: 'application/vnd.npm.install-v1+json',
})
const depsDevNotFound: Reply = {
  status: 404,
  type: 'text/plain; charset=utf-8',
  body: registryBody('not-found.deps-dev'),
}

/** The registry's table for `ms`: dist-tags and the abbreviated packument. */
const msRegistry = (): Handler =>
  replies({
    '/-/package/ms/dist-tags': ok('ms.dist-tags'),
    '/ms': packument('ms.packument'),
  })

const msDepsDev = (): Handler =>
  replies({ [`${DEPS_DEV_PREFIX}ms`]: ok('ms.deps-dev') })

const never: Handler = () => undefined

const accepts = (server: TestRegistry): Array<string | undefined> =>
  server.requests.map((r) => r.headers.accept)

describe('registry reader', () => {
  const servers: TestRegistry[] = []
  const clients: RegistryClient[] = []

  const start = async (handler: Handler): Promise<TestRegistry> => {
    const server = await startRegistry(handler)
    servers.push(server)
    return server
  }

  /** A registry and a deps.dev on separate servers, and a reader over both. */
  const setup = async (
    handlers: { registry: Handler; depsDev?: Handler },
    options: { depsDev?: boolean; config?: Partial<RegistryConfig> } = {},
  ) => {
    const registry = await start(handlers.registry)
    const depsDev = await start(handlers.depsDev ?? msDepsDev())
    const endpoints: RegistryEndpoints = {
      publicRegistries: [new URL(registry.url).origin],
      depsDev: `${depsDev.url}v3/systems/npm/packages/`,
    }
    const registryConfig = configFor(registry.url, options.config)
    const client = createRegistryClient(registryConfig, {
      sleep: async () => undefined,
    })
    clients.push(client)
    const reader = createRegistryReader({
      registryConfig,
      client: async () => client,
      depsDev: options.depsDev ?? true,
      endpoints,
    })
    return { registry, depsDev, reader, registryConfig }
  }

  const packageOf = (lookup: PackageLookup) => {
    if (!lookup.ok) throw new Error(`lookup failed: ${lookup.reason}`)
    return lookup.package
  }

  afterEach(async () => {
    for (const client of clients.splice(0)) client.destroy()
    await Promise.all(servers.splice(0).map((s) => s.close()))
  })

  describe('public npm names through deps.dev', () => {
    it('takes latest from dist-tags and versions from deps.dev, in two requests', async () => {
      const { registry, depsDev, reader } = await setup({
        registry: msRegistry(),
      })

      const result = packageOf(await reader.lookup('ms'))

      expect(result).toMatchObject({
        name: 'ms',
        latest: '2.1.3',
        source: 'deps.dev',
      })
      expect(result.versions).toHaveLength(32)
      expect(result.versions.every((v) => v.publishedAt)).toBe(true)
      expect(registry.requests.map((r) => r.url)).toEqual([
        '/-/package/ms/dist-tags',
      ])
      expect(depsDev.requests.map((r) => r.url)).toEqual([
        `${DEPS_DEV_PREFIX}ms`,
      ])
      expect(accepts(registry)).toEqual(['application/json'])
      expect(accepts(depsDev)).toEqual(['application/json'])
    })

    it('escapes a scoped name for both services', async () => {
      const { registry, depsDev, reader } = await setup({
        registry: replies({
          '/-/package/@types%2fms/dist-tags': ok('types-ms.dist-tags'),
        }),
        depsDev: replies({
          [`${DEPS_DEV_PREFIX}%40types%2Fms`]: ok('types-ms.deps-dev'),
        }),
      })

      const result = packageOf(await reader.lookup('@types/ms'))

      expect(result).toMatchObject({ latest: '2.1.0', source: 'deps.dev' })
      expect(registry.requests.map((r) => r.url)).toEqual([
        '/-/package/@types%2fms/dist-tags',
      ])
      expect(depsDev.requests.map((r) => r.url)).toEqual([
        `${DEPS_DEV_PREFIX}%40types%2Fms`,
      ])
    })

    it('marks deprecated versions and keeps latest among the live ones', async () => {
      const { reader } = await setup({
        registry: replies({
          '/-/package/mkdirp/dist-tags': ok('mkdirp.dist-tags'),
        }),
        depsDev: replies({
          [`${DEPS_DEV_PREFIX}mkdirp`]: ok('mkdirp.deps-dev'),
        }),
      })

      const result = packageOf(await reader.lookup('mkdirp'))

      expect(result.latest).toBe('3.0.1')
      expect(result.versions.filter((v) => v.deprecated)).toHaveLength(25)
      expect(
        result.versions.find((v) => v.version === '3.0.1')?.deprecated,
      ).toBe(false)
    })
  })

  describe('falling back to the abbreviated packument', () => {
    const lacksLatest = derive<{
      versions: Array<{ versionKey: { version: string } }>
    }>('ms.deps-dev', (body) => {
      body.versions = body.versions.filter(
        (v) => v.versionKey.version !== '2.1.3',
      )
    })

    it.each([
      ['deps.dev does not list latest', { body: lacksLatest }, 200],
      ['deps.dev answers 404', depsDevNotFound, 404],
      ['deps.dev answers 429', { status: 429, body: 'slow down' }, 429],
      ['deps.dev answers 500', { status: 500, body: 'oops' }, 500],
      ['deps.dev sends something else', { body: '{"versions":"many"}' }, 200],
    ] as Array<[string, Reply, number]>)('when %s', async (_label, reply) => {
      const { registry, reader } = await setup({
        registry: msRegistry(),
        depsDev: replies({ [`${DEPS_DEV_PREFIX}ms`]: reply }),
      })

      const result = packageOf(await reader.lookup('ms'))

      expect(result).toMatchObject({
        latest: '2.1.3',
        source: 'packument',
      })
      expect(result.versions).toHaveLength(32)
      expect(registry.requests.map((r) => r.url)).toEqual([
        '/-/package/ms/dist-tags',
        '/ms',
      ])
      expect(accepts(registry)[1]).toBe(ABBREVIATED_ACCEPT)
    })

    it('when deps.dev cannot be reached', async () => {
      const { registry, depsDev, reader } = await setup({
        registry: msRegistry(),
      })
      await depsDev.close()

      const result = packageOf(await reader.lookup('ms'))

      expect(result.source).toBe('packument')
      expect(accepts(registry)[1]).toBe(ABBREVIATED_ACCEPT)
    })

    it('asks a failing deps.dev once even when fetch-retries is set', async () => {
      const { depsDev, reader } = await setup(
        {
          registry: msRegistry(),
          depsDev: replies({
            [`${DEPS_DEV_PREFIX}ms`]: { status: 503, body: '' },
          }),
        },
        { config: { fetchRetries: 2 } },
      )

      expect(packageOf(await reader.lookup('ms')).source).toBe('packument')
      expect(depsDev.requests).toHaveLength(1)
    })

    it('when deps.dev hangs, after its own timeout rather than fetch-timeout', async () => {
      const { reader } = await setup(
        { registry: msRegistry(), depsDev: never },
        { config: { fetchTimeout: 100 } },
      )

      const result = packageOf(await reader.lookup('ms'))

      expect(result.source).toBe('packument')
    })
  })

  describe('the deps.dev breaker', () => {
    const twoNames = (): Handler =>
      replies({
        '/-/package/ms/dist-tags': ok('ms.dist-tags'),
        '/ms': packument('ms.packument'),
        '/-/package/mkdirp/dist-tags': ok('mkdirp.dist-tags'),
        '/mkdirp': packument('mkdirp.packument'),
      })

    const sameNames = (names: string[]): Handler =>
      replies(
        Object.fromEntries(
          names.flatMap((n) => [
            [`/-/package/${n}/dist-tags`, ok('ms.dist-tags')],
            [`/${n}`, packument('ms.packument')],
          ]),
        ),
      )

    /** deps.dev fails `ms` with `fail` and serves `mkdirp`. */
    const asksAgainAfter = async (fail: Handler) => {
      const mkdirp = replies({
        [`${DEPS_DEV_PREFIX}mkdirp`]: ok('mkdirp.deps-dev'),
      })
      const { registry, depsDev, reader } = await setup({
        registry: twoNames(),
        depsDev: (req, res) =>
          (req.url === `${DEPS_DEV_PREFIX}ms` ? fail : mkdirp)(req, res),
      })

      const first = packageOf(await reader.lookup('ms'))
      const second = packageOf(await reader.lookup('mkdirp'))

      expect(first.source).toBe('packument')
      expect(second.source).toBe('deps.dev')
      expect(depsDev.requests.map((r) => r.url)).toEqual([
        `${DEPS_DEV_PREFIX}ms`,
        `${DEPS_DEV_PREFIX}mkdirp`,
      ])
      expect(registry.requests.map((r) => r.url)).not.toContain('/mkdirp')
    }

    it('falls back for one package after a 503 and asks deps.dev again', async () => {
      await asksAgainAfter((_req, res) => {
        res.statusCode = 503
        res.end('')
      })
    })

    it('falls back for one package after a connection reset and asks deps.dev again', async () => {
      await asksAgainAfter((req) => req.socket.destroy())
    })

    it('stops asking deps.dev after a 429', async () => {
      const { registry, depsDev, reader } = await setup({
        registry: twoNames(),
        depsDev: replies({
          [`${DEPS_DEV_PREFIX}ms`]: { status: 429, body: '' },
        }),
      })

      await reader.lookup('ms')
      expect(depsDev.requests).toHaveLength(1)

      const second = packageOf(await reader.lookup('mkdirp'))

      expect(depsDev.requests).toHaveLength(1)
      expect(second.source).toBe('packument')
      expect(registry.requests.map((r) => r.url).slice(-1)).toEqual(['/mkdirp'])
      expect(registry.requests.map((r) => r.url)).not.toContain(
        '/-/package/mkdirp/dist-tags',
      )
    })

    it('stops asking deps.dev after a timeout', async () => {
      const { depsDev, reader } = await setup(
        {
          registry: twoNames(),
          depsDev: (req, res) => {
            if (req.url !== `${DEPS_DEV_PREFIX}ms`) {
              res.end(registryBody('mkdirp.deps-dev'))
            }
          },
        },
        { config: { fetchTimeout: 100 } },
      )

      await reader.lookup('ms')
      const second = packageOf(await reader.lookup('mkdirp'))

      expect(depsDev.requests).toHaveLength(1)
      expect(second.source).toBe('packument')
    })

    it('stops asking deps.dev after three 5xx failures', async () => {
      const names = ['a', 'b', 'c', 'd']
      const { registry, depsDev, reader } = await setup({
        registry: sameNames(names),
        depsDev: (_req, res) => {
          res.statusCode = 503
          res.end('')
        },
      })

      for (const n of names) {
        expect(packageOf(await reader.lookup(n)).source).toBe('packument')
      }

      expect(depsDev.requests).toHaveLength(3)
      expect(registry.requests.map((r) => r.url)).toContain('/d')
      expect(registry.requests.map((r) => r.url)).not.toContain(
        '/-/package/d/dist-tags',
      )
    })

    it('sends nothing to deps.dev from lookups already queued when it trips', async () => {
      const names = ['a', 'b', 'c', 'd', 'e']
      const { depsDev, reader } = await setup(
        {
          registry: replies(
            Object.fromEntries(
              names.flatMap((n) => [
                [`/-/package/${n}/dist-tags`, ok('ms.dist-tags')],
                [`/${n}`, packument('ms.packument')],
              ]),
            ),
          ),
          depsDev: replies({
            [`${DEPS_DEV_PREFIX}a`]: { status: 429, body: '' },
          }),
        },
        { config: { maxSockets: 1 } },
      )

      const results = await Promise.all(names.map((n) => reader.lookup(n)))

      expect(results.every((r) => r.ok)).toBe(true)
      expect(depsDev.requests).toHaveLength(1)
    })

    it('keeps asking deps.dev after a 404', async () => {
      const { depsDev, reader } = await setup({
        registry: twoNames(),
        depsDev: replies({
          [`${DEPS_DEV_PREFIX}ms`]: depsDevNotFound,
          [`${DEPS_DEV_PREFIX}mkdirp`]: ok('mkdirp.deps-dev'),
        }),
      })

      await reader.lookup('ms')
      const second = packageOf(await reader.lookup('mkdirp'))

      expect(depsDev.requests.map((r) => r.url)).toEqual([
        `${DEPS_DEV_PREFIX}ms`,
        `${DEPS_DEV_PREFIX}mkdirp`,
      ])
      expect(second.source).toBe('deps.dev')
    })
  })

  describe('depsDev: false', () => {
    it('reads a public name from its packument alone', async () => {
      const { registry, depsDev, reader } = await setup(
        { registry: msRegistry() },
        { depsDev: false },
      )

      const result = packageOf(await reader.lookup('ms'))

      expect(result).toMatchObject({ latest: '2.1.3', source: 'packument' })
      expect(depsDev.requests).toEqual([])
      expect(registry.requests.map((r) => r.url)).toEqual(['/ms'])
      expect(accepts(registry)).toEqual([ABBREVIATED_ACCEPT])
    })
  })

  describe('other registries', () => {
    it('reads a name with one abbreviated GET and never asks deps.dev', async () => {
      const mirror = await start(
        replies({ '/mirror/ms': packument('ms.packument') }),
      )
      const { depsDev } = await setup({ registry: msRegistry() })
      const registryConfig = configFor(`${mirror.url}mirror/`)
      const client = createRegistryClient(registryConfig)
      clients.push(client)
      const own = createRegistryReader({
        registryConfig,
        client: async () => client,
        depsDev: true,
        endpoints: {
          publicRegistries: [new URL(mirror.url).origin],
          depsDev: `${depsDev.url}v3/systems/npm/packages/`,
        },
      })

      const result = packageOf(await own.lookup('ms'))

      expect(result).toMatchObject({ latest: '2.1.3', source: 'packument' })
      expect(mirror.requests.map((r) => r.url)).toEqual(['/mirror/ms'])
      expect(accepts(mirror)).toEqual([ABBREVIATED_ACCEPT])
      expect(depsDev.requests).toEqual([])
    })

    it('gives versions a publish time when the registry serves the full document there', async () => {
      const mirror = await start(
        replies({
          '/mirror/@types%2fms': {
            body: registryBody('types-ms.packument-full'),
          },
        }),
      )
      const registryConfig = configFor(`${mirror.url}mirror/`)
      const client = createRegistryClient(registryConfig)
      clients.push(client)
      const reader = createRegistryReader({
        registryConfig,
        client: async () => client,
        depsDev: true,
        endpoints: {
          publicRegistries: [new URL(mirror.url).origin],
          depsDev: 'http://127.0.0.1:1/',
        },
      })

      const result = packageOf(await reader.lookup('@types/ms'))

      expect(result.latest).toBe('2.1.0')
      expect(result.versions.every((v) => v.publishedAt)).toBe(true)
    })

    it('asks a scope registry with its own token, and tells nobody else', async () => {
      const corp = await start(
        replies({ '/@corp%2fpkg': packument('types-ms.packument') }),
      )
      const { registry, depsDev, registryConfig } = await setup({
        registry: msRegistry(),
      })
      const scoped: RegistryConfig = {
        ...registryConfig,
        scopedRegistries: { '@corp': corp.url },
        credentials: { [`//127.0.0.1:${corp.port}/`]: { authToken: 'CORP' } },
      }
      const client = createRegistryClient(scoped)
      clients.push(client)
      const own = createRegistryReader({
        registryConfig: scoped,
        client: async () => client,
        depsDev: true,
        endpoints: {
          publicRegistries: [new URL(registry.url).origin],
          depsDev: `${depsDev.url}v3/systems/npm/packages/`,
        },
      })

      const result = packageOf(await own.lookup('@corp/pkg'))

      expect(result.source).toBe('packument')
      expect(
        corp.requests.map((r) => [r.url, r.headers.authorization]),
      ).toEqual([['/@corp%2fpkg', 'Bearer CORP']])
      expect(registry.requests).toEqual([])
      expect(depsDev.requests).toEqual([])
    })
  })

  it('sends registry credentials to the registry and none to deps.dev', async () => {
    const registry = await start(msRegistry())
    const depsDev = await start(msDepsDev())
    const registryConfig = configFor(registry.url, {
      credentials: { [`//127.0.0.1:${registry.port}/`]: { authToken: 'TOK' } },
    })
    const client = createRegistryClient(registryConfig)
    clients.push(client)
    const reader = createRegistryReader({
      registryConfig,
      client: async () => client,
      depsDev: true,
      endpoints: {
        publicRegistries: [new URL(registry.url).origin],
        depsDev: `${depsDev.url}v3/systems/npm/packages/`,
      },
    })

    expect(packageOf(await reader.lookup('ms')).source).toBe('deps.dev')

    expect(registry.requests.map((r) => r.headers.authorization)).toEqual([
      'Bearer TOK',
    ])
    expect(depsDev.requests).toHaveLength(1)
    expect(depsDev.requests[0]?.headers.authorization).toBeUndefined()
  })

  describe('the packument wins', () => {
    it('uses its own latest when it lacks the one dist-tags names', async () => {
      const { reader } = await setup({
        registry: replies({
          '/-/package/ms/dist-tags': {
            body: derive<{ latest: string }>('ms.dist-tags', (b) => {
              b.latest = '9.9.9'
            }),
          },
          '/ms': packument('ms.packument'),
        }),
      })

      expect(packageOf(await reader.lookup('ms'))).toMatchObject({
        latest: '2.1.3',
        source: 'packument',
      })
    })

    it('uses the highest stable version when it has no latest either', async () => {
      const { reader } = await setup(
        {
          registry: replies({
            '/ms': {
              body: derive<{ 'dist-tags': Record<string, string> }>(
                'ms.packument',
                (b) => {
                  b['dist-tags'] = {}
                },
              ),
            },
          }),
        },
        { depsDev: false },
      )

      expect(packageOf(await reader.lookup('ms')).latest).toBe('2.1.3')
    })

    it('uses the packument when the dist-tags request fails other than with 404', async () => {
      const { registry, reader } = await setup({
        registry: replies({
          '/-/package/ms/dist-tags': { status: 500, body: 'oops' },
          '/ms': packument('ms.packument'),
        }),
      })

      expect(packageOf(await reader.lookup('ms')).source).toBe('packument')
      expect(registry.requests.map((r) => r.url)).toEqual([
        '/-/package/ms/dist-tags',
        '/ms',
      ])
    })
  })

  describe('not found', () => {
    it('retries an abbreviated 404 once for the full document', async () => {
      const seen: Array<string | undefined> = []
      const { reader } = await setup(
        {
          registry: (req, res) => {
            seen.push(req.headers.accept)
            if (req.headers.accept === 'application/json') {
              res.setHeader('content-type', 'application/json')
              res.end(registryBody('ms.packument'))
            } else {
              res.statusCode = 404
              res.end()
            }
          },
        },
        { depsDev: false },
      )

      expect(packageOf(await reader.lookup('ms')).latest).toBe('2.1.3')
      expect(seen).toEqual([ABBREVIATED_ACCEPT, 'application/json'])
    })

    it('reports not-found after a second 404', async () => {
      const { registry, reader } = await setup(
        { registry: replies({}) },
        { depsDev: false },
      )

      const result = await reader.lookup('autd-no-such-package-20261026')

      expect(result).toMatchObject({ ok: false, kind: 'not-found' })
      expect(accepts(registry)).toEqual([
        ABBREVIATED_ACCEPT,
        'application/json',
      ])
    })

    it('reports not-found for a dist-tags 404 and reads no packument', async () => {
      const { registry, reader } = await setup({
        registry: replies({}),
        depsDev: replies({
          [`${DEPS_DEV_PREFIX}autd-no-such-package-20261026`]: depsDevNotFound,
        }),
      })

      const result = await reader.lookup('autd-no-such-package-20261026')

      expect(result).toMatchObject({ ok: false, kind: 'not-found' })
      expect(registry.requests.map((r) => r.url)).toEqual([
        '/-/package/autd-no-such-package-20261026/dist-tags',
      ])
    })

    it('reports not-found for a packument without versions', async () => {
      const { reader } = await setup(
        { registry: replies({ '/ms': { body: '{"versions":{}}' } }) },
        { depsDev: false },
      )

      expect(await reader.lookup('ms')).toMatchObject({
        ok: false,
        kind: 'not-found',
      })
    })
  })

  describe('failures', () => {
    it('reports an unreachable registry as a request failure, never as no versions', async () => {
      const { registry, reader } = await setup({ registry: msRegistry() })
      await registry.close()

      const result = await reader.lookup('ms')

      expect(result).toMatchObject({ ok: false, name: 'ms', kind: 'request' })
      expect(result.ok ? '' : result.reason).toMatch(/ECONNREFUSED|connect/)
    })

    it('reports a server error as a request failure', async () => {
      const { reader } = await setup(
        {
          registry: replies({ '/ms': { status: 500, body: 'oops' } }),
        },
        { depsDev: false },
      )

      expect(await reader.lookup('ms')).toMatchObject({
        ok: false,
        kind: 'request',
        reason: expect.stringContaining('500'),
      })
    })

    it.each([
      ['an array', '[]'],
      ['an object without versions', '{"name":"ms"}'],
    ])('reports %s as an invalid document', async (_label, body) => {
      const { reader } = await setup(
        { registry: replies({ '/ms': { body } }) },
        { depsDev: false },
      )

      const result = await reader.lookup('ms')

      expect(result).toMatchObject({ ok: false, kind: 'invalid' })
    })

    it('reports a body that is not JSON as a failed request', async () => {
      const { reader } = await setup(
        { registry: replies({ '/ms': { body: 'oops' } }) },
        { depsDev: false },
      )

      expect(await reader.lookup('ms')).toMatchObject({
        ok: false,
        kind: 'request',
        reason: expect.stringContaining('not valid JSON'),
      })
    })

    it('makes no request for an invalid name', async () => {
      const { registry, depsDev, reader } = await setup({
        registry: msRegistry(),
      })

      const result = await reader.lookup('../etc/passwd')

      expect(result).toMatchObject({ ok: false, kind: 'invalid' })
      expect(registry.requests).toEqual([])
      expect(depsDev.requests).toEqual([])
    })

    it('keeps URL userinfo out of every reason', async () => {
      const server = await start(msRegistry())
      const url = new URL(server.url)
      url.username = 'alice'
      url.password = 'hunter2'
      await server.close()
      const registryConfig = configFor(url.href)
      const client = createRegistryClient(registryConfig)
      clients.push(client)
      const reader = createRegistryReader({
        registryConfig,
        client: async () => client,
        depsDev: false,
      })

      const result = await reader.lookup('ms')

      expect(result.ok).toBe(false)
      expect(JSON.stringify(result)).not.toMatch(/alice|hunter2/)
    })
  })

  it('shares the requests of concurrent lookups of one name', async () => {
    const { registry, depsDev, reader } = await setup({
      registry: msRegistry(),
    })

    const results = await Promise.all([
      reader.lookup('ms'),
      reader.lookup('ms'),
      reader.lookup('ms'),
    ])

    expect(results[1]).toBe(results[0])
    expect(registry.requests).toHaveLength(1)
    expect(depsDev.requests).toHaveLength(1)
  })

  it('keeps no more than maxSockets requests in flight to one host', async () => {
    const combined = await start((req, res) => {
      setTimeout(() => {
        res.setHeader('content-type', 'application/json')
        res.end(
          registryBody(
            req.url?.startsWith(DEPS_DEV_PREFIX)
              ? 'ms.deps-dev'
              : 'ms.dist-tags',
          ),
        )
      }, 20)
    })
    const registryConfig = configFor(combined.url, { maxSockets: 2 })
    const client = createRegistryClient(registryConfig)
    clients.push(client)
    const reader = createRegistryReader({
      registryConfig,
      client: async () => client,
      depsDev: true,
      endpoints: {
        publicRegistries: [new URL(combined.url).origin],
        depsDev: `${combined.url}v3/systems/npm/packages/`,
      },
    })

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => reader.lookup(`pkg-${i}`)),
    )

    expect(results.every((r) => r.ok)).toBe(true)
    expect(combined.requests).toHaveLength(16)
    expect(combined.peak).toBeLessThanOrEqual(2)
  })

  it('limits each host to maxSockets, so two hosts can overlap', async () => {
    let inFlight = 0
    let overall = 0
    const slow =
      (body: string): Handler =>
      (_req, res) => {
        overall = Math.max(overall, ++inFlight)
        setTimeout(() => {
          inFlight--
          res.setHeader('content-type', 'application/json')
          res.end(registryBody(body))
        }, 20)
      }
    const { registry, depsDev, reader } = await setup(
      { registry: slow('ms.dist-tags'), depsDev: slow('ms.deps-dev') },
      { config: { maxSockets: 2 } },
    )

    const results = await Promise.all(
      Array.from({ length: 8 }, (_, i) => reader.lookup(`pkg-${i}`)),
    )

    expect(results.every((r) => r.ok)).toBe(true)
    expect(registry.peak).toBe(2)
    expect(depsDev.peak).toBe(2)
    expect(overall).toBeGreaterThan(2)
    expect(overall).toBeLessThanOrEqual(4)
  })

  describe('with the disk cache', () => {
    const START = Date.UTC(2026, 9, 27)
    const SECOND = 1000
    let dir: string
    let clock: number

    beforeEach(() => {
      dir = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'autd-reader-cache-')),
      )
      clock = START
    })
    afterEach(() => {
      fs.rmSync(dir, { recursive: true, force: true })
    })

    /** A handler a test can swap between runs. */
    const switchable = (initial: Handler) => {
      let current = initial
      const handler: Handler = (req, res) => current(req, res)
      return {
        handler,
        use: (next: Handler) => {
          current = next
        },
      }
    }

    const status =
      (code: number): Handler =>
      (_req, res) => {
        res.statusCode = code
        res.end('failed')
      }

    /**
     * A registry and a deps.dev whose requests the test counts, and `run()`:
     * one command run, a new reader over a new client and a new cache handle
     * on the same folder, as a second `autd check` is.
     */
    const cached = async (
      handlers: { registry: Handler; depsDev?: Handler },
      options: {
        depsDev?: boolean
        credentials?: boolean
        cacheDir?: string
      } = {},
    ) => {
      const registry = await start(handlers.registry)
      const depsDev = await start(handlers.depsDev ?? msDepsDev())
      const endpoints: RegistryEndpoints = {
        publicRegistries: [new URL(registry.url).origin],
        depsDev: `${depsDev.url}v3/systems/npm/packages/`,
      }
      const registryConfig = configFor(registry.url, {
        credentials: options.credentials
          ? { [`//127.0.0.1:${registry.port}/`]: { authToken: 'TOK' } }
          : {},
      })
      const run = () => {
        let made = 0
        let client: RegistryClient | undefined
        const cache = createRegistryCache({
          dir: options.cacheDir ?? dir,
          now: () => clock,
        })
        const reader = createRegistryReader({
          registryConfig,
          client: async () => {
            made++
            client ??= createRegistryClient(registryConfig, {
              sleep: async () => undefined,
            })
            clients.push(client)
            return client
          },
          depsDev: options.depsDev ?? true,
          endpoints,
          cache,
        })
        return { reader, cache, clientsMade: () => made }
      }
      /** The URLs each server was asked since the last call. */
      const asked = () => ({
        registry: registry.requests.splice(0).map((r) => r.url),
        depsDev: depsDev.requests.splice(0).map((r) => r.url),
      })
      return { registry, depsDev, run, asked }
    }

    const filesIn = (kind: string): string[] => {
      try {
        return fs.readdirSync(path.join(dir, 'v1', kind))
      } catch {
        return []
      }
    }

    describe('a public name through dist-tags and deps.dev', () => {
      it('answers a second run within the TTL without a request or a client', async () => {
        const { run, asked } = await cached({ registry: msRegistry() })
        const first = packageOf(await run().reader.lookup('ms'))
        expect(asked().registry).toEqual(['/-/package/ms/dist-tags'])

        clock += 299 * SECOND
        const second = run()
        const result = packageOf(await second.reader.lookup('ms'))

        expect(result).toEqual(first)
        expect(result.source).toBe('deps.dev')
        expect(asked()).toEqual({ registry: [], depsDev: [] })
        expect(second.clientsMade()).toBe(0)
      })

      it('asks dist-tags alone once its 300 s are over', async () => {
        const { run, asked } = await cached({ registry: msRegistry() })
        await run().reader.lookup('ms')
        asked()

        clock += 301 * SECOND
        const result = packageOf(await run().reader.lookup('ms'))

        expect(result.source).toBe('deps.dev')
        expect(asked()).toEqual({
          registry: ['/-/package/ms/dist-tags'],
          depsDev: [],
        })
      })

      it('asks both once deps.dev is an hour old', async () => {
        const { run, asked } = await cached({ registry: msRegistry() })
        await run().reader.lookup('ms')
        asked()

        clock += 3601 * SECOND
        await run().reader.lookup('ms')

        expect(asked()).toEqual({
          registry: ['/-/package/ms/dist-tags'],
          depsDev: [`${DEPS_DEV_PREFIX}ms`],
        })
      })

      describe('a fresh deps.dev entry that lacks the latest dist-tags names', () => {
        const lacksLatest = derive<{
          versions: Array<{ versionKey: { version: string } }>
        }>('ms.deps-dev', (body) => {
          body.versions = body.versions.filter(
            (v) => v.versionKey.version !== '2.1.3',
          )
        })

        it('asks deps.dev once more, and uses what it now lists', async () => {
          const depsDevSide = switchable(
            replies({ [`${DEPS_DEV_PREFIX}ms`]: { body: lacksLatest } }),
          )
          const { run, asked } = await cached({
            registry: msRegistry(),
            depsDev: depsDevSide.handler,
          })
          expect(packageOf(await run().reader.lookup('ms')).source).toBe(
            'packument',
          )
          asked()
          depsDevSide.use(msDepsDev())

          clock += 10 * SECOND
          const result = packageOf(await run().reader.lookup('ms'))

          expect(result.source).toBe('deps.dev')
          expect(asked()).toEqual({
            registry: [],
            depsDev: [`${DEPS_DEV_PREFIX}ms`],
          })
        })

        it('reads the packument when deps.dev still lacks it', async () => {
          const { run, asked } = await cached({
            registry: msRegistry(),
            depsDev: replies({
              [`${DEPS_DEV_PREFIX}ms`]: { body: lacksLatest },
            }),
          })
          await run().reader.lookup('ms')
          asked()

          clock += 301 * SECOND
          const result = packageOf(await run().reader.lookup('ms'))

          expect(result.source).toBe('packument')
          expect(asked()).toEqual({
            registry: ['/-/package/ms/dist-tags', '/ms'],
            depsDev: [`${DEPS_DEV_PREFIX}ms`],
          })
        })
      })
    })

    describe('the packument path', () => {
      const etagged = (etag: string) =>
        conditional(packument('ms.packument'), etag)

      it('revalidates with If-None-Match, and a 304 answers with the same versions', async () => {
        const side = switchable(etagged('W/"one"'))
        const { registry, run, asked } = await cached(
          { registry: side.handler },
          { depsDev: false },
        )
        const first = packageOf(await run().reader.lookup('ms'))
        asked()

        clock += 301 * SECOND
        const second = run()
        const result = packageOf(await second.reader.lookup('ms'))

        expect(result).toEqual(first)
        expect(asked().registry).toEqual(['/ms'])
        expect(registry.requests).toEqual([])
        expect(second.reader.stats().notModified).toBe(1)
      })

      it('sends the stored ETag and replaces the entry when the registry sends a new one', async () => {
        const side = switchable(etagged('W/"one"'))
        const { registry, run } = await cached(
          { registry: side.handler },
          { depsDev: false },
        )
        await run().reader.lookup('ms')
        side.use(etagged('W/"two"'))

        clock += 301 * SECOND
        const replaced = run()
        await replaced.reader.lookup('ms')
        clock += 301 * SECOND
        const confirmed = run()
        await confirmed.reader.lookup('ms')

        expect(
          registry.requests.map((r) => r.headers['if-none-match']),
        ).toEqual([undefined, 'W/"one"', 'W/"two"'])
        expect(replaced.reader.stats().notModified).toBe(0)
        expect(confirmed.reader.stats().notModified).toBe(1)
      })

      it('revalidates a fresh entry that lacks the latest dist-tags names', async () => {
        const without = derive<{
          versions: Record<string, unknown>
          'dist-tags': Record<string, string>
        }>('ms.packument', (body) => {
          delete body.versions['2.1.3']
          body['dist-tags'].latest = '2.1.2'
        })
        const side = switchable(
          replies({
            '/ms': { body: without },
            '/-/package/ms/dist-tags': ok('ms.dist-tags'),
          }),
        )
        const { run, asked } = await cached({
          registry: side.handler,
          depsDev: status(404),
        })
        expect(packageOf(await run().reader.lookup('ms')).latest).toBe('2.1.2')
        asked()
        side.use(
          replies({
            '/ms': packument('ms.packument'),
            '/-/package/ms/dist-tags': ok('ms.dist-tags'),
          }),
        )

        clock += 10 * SECOND
        const result = packageOf(await run().reader.lookup('ms'))

        expect(result.latest).toBe('2.1.3')
        expect(asked().registry).toEqual(['/ms'])
      })

      it('keeps the full document, publish times included, when the abbreviated one is 404', async () => {
        const full = replies({
          '/@types%2fms': { body: registryBody('types-ms.packument-full') },
        })
        const { run, asked } = await cached(
          {
            registry: (req, res) =>
              req.headers.accept === ABBREVIATED_ACCEPT
                ? status(404)(req, res)
                : full(req, res),
          },
          { depsDev: false },
        )
        await run().reader.lookup('@types/ms')
        expect(asked().registry).toHaveLength(2)

        clock += 60 * SECOND
        const result = packageOf(await run().reader.lookup('@types/ms'))

        expect(result.latest).toBe('2.1.0')
        expect(result.versions.every((v) => v.publishedAt)).toBe(true)
        expect(asked().registry).toEqual([])
      })
    })

    describe('depsDev: false', () => {
      it('reads and writes no deps.dev entry', async () => {
        const { run, asked } = await cached({ registry: msRegistry() })
        await run().reader.lookup('ms')
        asked()
        const entry = path.join(dir, 'v1', 'deps.dev')
        const before = fs.statSync(
          path.join(entry, filesIn('deps.dev')[0] ?? ''),
        )

        clock += 10 * SECOND
        const off = await cached({ registry: msRegistry() }, { depsDev: false })
        const result = packageOf(await off.run().reader.lookup('ms'))

        expect(result.source).toBe('packument')
        expect(off.asked().depsDev).toEqual([])
        expect(filesIn('deps.dev')).toHaveLength(1)
        // A read would have touched the file to the new time.
        expect(
          fs.statSync(path.join(entry, filesIn('deps.dev')[0] ?? '')).mtimeMs,
        ).toBe(before.mtimeMs)
      })

      it('writes none from a clean folder', async () => {
        const { run } = await cached(
          { registry: msRegistry() },
          { depsDev: false },
        )

        await run().reader.lookup('ms')

        expect(filesIn('deps.dev')).toEqual([])
        expect(filesIn('packument')).toHaveLength(1)
      })
    })

    describe('an authenticated registry (Q1 a)', () => {
      it('does not keep dist-tags when deps.dev does not list the name', async () => {
        const { run, asked } = await cached(
          { registry: msRegistry(), depsDev: replies({}) },
          { credentials: true },
        )
        expect(packageOf(await run().reader.lookup('ms')).source).toBe(
          'packument',
        )
        asked()

        clock += 10 * SECOND
        await run().reader.lookup('ms')

        expect(filesIn('dist-tags')).toEqual([])
        expect(asked().registry).toEqual(['/-/package/ms/dist-tags', '/ms'])
      })

      it('keeps dist-tags when deps.dev lists the name: the answer is the same for everyone', async () => {
        const { run, asked } = await cached(
          { registry: msRegistry() },
          { credentials: true },
        )
        await run().reader.lookup('ms')
        asked()

        clock += 10 * SECOND
        await run().reader.lookup('ms')

        expect(filesIn('dist-tags')).toHaveLength(1)
        expect(asked()).toEqual({ registry: [], depsDev: [] })
      })

      it('asks again, with the ETag, on every run for a packument that is not public', async () => {
        const { registry, run } = await cached(
          { registry: conditional(packument('ms.packument'), 'W/"auth"') },
          { depsDev: false, credentials: true },
        )

        await run().reader.lookup('ms')
        clock += SECOND
        await run().reader.lookup('ms')
        clock += SECOND
        const third = run()
        await third.reader.lookup('ms')

        expect(
          registry.requests.map((r) => r.headers['if-none-match']),
        ).toEqual([undefined, 'W/"auth"', 'W/"auth"'])
        expect(third.reader.stats().notModified).toBe(1)
      })

      it('does not keep a packument that has no ETag', async () => {
        const { run, asked } = await cached(
          { registry: msRegistry() },
          { depsDev: false, credentials: true },
        )
        await run().reader.lookup('ms')
        asked()

        clock += SECOND
        await run().reader.lookup('ms')

        expect(filesIn('packument')).toEqual([])
        expect(asked().registry).toEqual(['/ms'])
      })

      it('serves a public answer without asking', async () => {
        const { run, asked } = await cached(
          {
            registry: conditional(
              {
                ...packument('ms.packument'),
                headers: { 'cache-control': 'public, max-age=300' },
              },
              'W/"pub"',
            ),
          },
          { depsDev: false, credentials: true },
        )
        await run().reader.lookup('ms')
        asked()

        clock += 10 * SECOND
        await run().reader.lookup('ms')

        expect(asked().registry).toEqual([])
      })
    })

    describe('Cache-Control', () => {
      it('keeps nothing the registry says not to store', async () => {
        const { run, asked } = await cached(
          {
            registry: replies({
              '/ms': {
                ...packument('ms.packument'),
                headers: { 'cache-control': 'no-store' },
              },
            }),
          },
          { depsDev: false },
        )
        await run().reader.lookup('ms')
        asked()

        clock += SECOND
        await run().reader.lookup('ms')

        expect(filesIn('packument')).toEqual([])
        expect(asked().registry).toEqual(['/ms'])
      })

      it('lowers the TTL to max-age', async () => {
        const { run, asked } = await cached(
          {
            registry: replies({
              '/ms': {
                ...packument('ms.packument'),
                headers: { 'cache-control': 'public, max-age=60' },
              },
            }),
          },
          { depsDev: false },
        )
        await run().reader.lookup('ms')
        asked()

        clock += 59 * SECOND
        await run().reader.lookup('ms')
        expect(asked().registry).toEqual([])

        clock += 2 * SECOND
        await run().reader.lookup('ms')
        expect(asked().registry).toEqual(['/ms'])
      })
    })

    describe('failures', () => {
      it('never answers from a stale entry when the request fails', async () => {
        const side = switchable(msRegistry())
        const { run } = await cached(
          { registry: side.handler },
          { depsDev: false },
        )
        expect((await run().reader.lookup('ms')).ok).toBe(true)
        side.use(status(500))

        clock += 301 * SECOND
        const result = await run().reader.lookup('ms')

        expect(result).toMatchObject({ ok: false, kind: 'request' })
      })

      it('gives the results of no cache when the folder cannot be written', async () => {
        const file = path.join(dir, 'in-the-way')
        fs.writeFileSync(file, 'a file, not a folder')
        const { run, asked } = await cached(
          { registry: msRegistry() },
          { cacheDir: file },
        )

        const first = packageOf(await run().reader.lookup('ms'))
        const second = packageOf(await run().reader.lookup('ms'))

        expect(first.source).toBe('deps.dev')
        expect(second).toEqual(first)
        expect(asked().registry).toHaveLength(2)
      })
    })
  })
})
