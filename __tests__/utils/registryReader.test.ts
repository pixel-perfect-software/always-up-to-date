jest.mock('@/utils/logger')

import type { PackageLookup, RegistryConfig } from '@/types'
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
      client,
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

    it.each([
      ['a 429', { status: 429, body: '' }],
      ['a 503', { status: 503, body: '' }],
    ] as Array<[string, Reply]>)(
      'stops asking deps.dev after %s',
      async (_label, reply) => {
        const { registry, depsDev, reader } = await setup({
          registry: twoNames(),
          depsDev: replies({ [`${DEPS_DEV_PREFIX}ms`]: reply }),
        })

        await reader.lookup('ms')
        expect(depsDev.requests).toHaveLength(1)

        const second = packageOf(await reader.lookup('mkdirp'))

        expect(depsDev.requests).toHaveLength(1)
        expect(second.source).toBe('packument')
        expect(registry.requests.map((r) => r.url).slice(-1)).toEqual([
          '/mkdirp',
        ])
        expect(registry.requests.map((r) => r.url)).not.toContain(
          '/-/package/mkdirp/dist-tags',
        )
      },
    )

    it('stops asking deps.dev after a transport failure', async () => {
      const { depsDev, reader } = await setup({ registry: twoNames() })
      await depsDev.close()

      await reader.lookup('ms')
      await reader.lookup('mkdirp')

      expect(depsDev.requests).toHaveLength(0)
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
        client,
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
        client,
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
        client,
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
      client,
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
        client,
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

  it('keeps no more than maxSockets requests in flight across both services', async () => {
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
      client,
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
})
