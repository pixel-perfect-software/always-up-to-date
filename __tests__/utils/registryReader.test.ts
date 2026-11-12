jest.mock('@/utils/logger')

import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import type { PackageLookup, RegistryConfig } from '@/types'
import logger from '@/utils/logger'
import { createRegistryCache, type RegistryCache } from '@/utils/registryCache'
import {
  createRegistryClient,
  type RegistryClient,
} from '@/utils/registryClient'
import { parseVersionManifest } from '@/utils/registryDocuments'
import {
  createRegistryReader,
  type RegistryReader,
} from '@/utils/registryReader'
import {
  ABBREVIATED_ACCEPT,
  type RegistryEndpoints,
} from '@/utils/registryUrls'
import { localRegistryConfig as configFor, tempDir } from '../fixtures/files'
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

const TYPES_MS = '@types/ms'
const PACKUMENT_URL = '/@types%2fms'
const DEPS_DEV_URL = `${DEPS_DEV_PREFIX}%40types%2Fms`
// deps.dev's time for 0.7.34 and the full packument's, a few ms apart.
const DEPS_DEV_0_7_34 = '2023-11-07T11:26:21Z'
const FULL_0_7_34 = '2023-11-07T11:26:21.925Z'
const FULL_2_1_0 = '2025-01-16T21:02:46.181Z'
const MOVING_TO_LATEST = { current: '0.7.34', target: '2.1.0' }

/**
 * `@types/ms` on a registry that answers the abbreviated packument and the
 * full one by `Accept`, as npm does, plus its dist-tags.
 */
const typesMsRegistry = (
  full: Reply | Handler = ok('types-ms.packument-full'),
  abbreviatedReply: Reply = packument('types-ms.packument'),
): Handler => {
  const abbreviated = replies({
    '/-/package/@types%2fms/dist-tags': ok('types-ms.dist-tags'),
    [PACKUMENT_URL]: abbreviatedReply,
  })
  const complete =
    typeof full === 'function' ? full : replies({ [PACKUMENT_URL]: full })
  return (req, res) => {
    const wantsFull =
      req.url === PACKUMENT_URL && req.headers.accept !== ABBREVIATED_ACCEPT
    return (wantsFull ? complete : abbreviated)(req, res)
  }
}

/** deps.dev one release behind: the dist-tags name 2.1.0, deps.dev does not list it. */
const lagging = derive<{
  versions: Array<{ versionKey: { version: string } }>
}>('types-ms.deps-dev', (body) => {
  body.versions = body.versions.filter((v) => v.versionKey.version !== '2.1.0')
})
const laggingDepsDev = (): Handler =>
  replies({ [DEPS_DEV_URL]: { body: lagging } })

const never: Handler = () => undefined

const status500: Handler = (_req, res) => {
  res.statusCode = 500
  res.end('oops')
}

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
    options: {
      depsDev?: boolean
      config?: Partial<RegistryConfig>
      cache?: RegistryCache
      depsDevTimeout?: number
    } = {},
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
      cache: options.cache,
      depsDevTimeout: options.depsDevTimeout,
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
        { depsDevTimeout: 100 },
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
      const { registry, reader } = await setup(
        {
          registry: twoNames(),
          depsDev: (req, res) => {
            if (req.url !== `${DEPS_DEV_PREFIX}ms`) {
              res.end(registryBody('mkdirp.deps-dev'))
            }
          },
        },
        { depsDevTimeout: 100 },
      )

      await reader.lookup('ms')
      const second = packageOf(await reader.lookup('mkdirp'))

      expect(
        jest
          .mocked(logger.debug)
          .mock.calls.map(([line]) => String(line))
          .some((line) => line.startsWith('deps.dev unavailable')),
      ).toBe(true)
      expect(second.source).toBe('packument')
      expect(registry.requests.map((r) => r.url)).not.toContain(
        '/-/package/mkdirp/dist-tags',
      )
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

  describe('modified (#177)', () => {
    it('is on a public registry lookup read from its packument, and the cache holds it', async () => {
      const dir = tempDir('autd-reader-modified-', { real: true })
      const cache = createRegistryCache({ dir })
      const { registry, reader } = await setup(
        { registry: msRegistry() },
        { depsDev: false, cache },
      )

      const result = packageOf(await reader.lookup('ms'))

      expect(result.modified).toBe('2025-09-08T19:56:54.242Z')
      expect(cache.get('packument', registry.url, 'ms')?.value.modified).toBe(
        '2025-09-08T19:56:54.242Z',
      )
    })

    it('is absent for a registry autd does not trust, while the cache still holds it', async () => {
      const dir = tempDir('autd-reader-modified-', { real: true })
      const mirror = await start(
        replies({ '/mirror/ms': packument('ms.packument') }),
      )
      const registryConfig = configFor(`${mirror.url}mirror/`)
      const client = createRegistryClient(registryConfig)
      clients.push(client)
      const cache = createRegistryCache({ dir })
      const own = createRegistryReader({
        registryConfig,
        client: async () => client,
        depsDev: true,
        endpoints: {
          publicRegistries: ['https://registry.npmjs.org'],
          depsDev: 'http://127.0.0.1:1/',
        },
        cache,
      })

      const result = packageOf(await own.lookup('ms'))

      expect(result.modified).toBeUndefined()
      expect(
        cache.get('packument', `${mirror.url}mirror/`, 'ms')?.value.modified,
      ).toBe('2025-09-08T19:56:54.242Z')
    })

    it('is absent for a scope routed to another registry', async () => {
      const corp = await start(
        replies({ '/@corp%2fpkg': packument('types-ms.packument') }),
      )
      const { registry, depsDev, registryConfig } = await setup({
        registry: msRegistry(),
      })
      const scoped: RegistryConfig = {
        ...registryConfig,
        scopedRegistries: { '@corp': corp.url },
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

      expect(packageOf(await own.lookup('@corp/pkg')).modified).toBeUndefined()
    })

    it('is absent when the packument is a full document', async () => {
      const { reader } = await setup(
        {
          registry: replies({
            '/@types%2fms': { body: registryBody('types-ms.packument-full') },
          }),
        },
        { depsDev: false },
      )

      expect(packageOf(await reader.lookup('@types/ms')).modified).toBe(
        undefined,
      )
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

    it.each([
      ['a 500', { status: 500, body: 'oops' }, '500'],
      ['invalid JSON', { body: 'oops' }, 'not valid JSON'],
    ])(
      'keeps a registry path token out of the reason for %s',
      async (_label, reply, expected) => {
        const server = await start(replies({ '/SECRET/acme/ms': reply }))
        const registryConfig = configFor(`${server.url}SECRET/acme/`)
        const client = createRegistryClient(registryConfig)
        clients.push(client)
        const reader = createRegistryReader({
          registryConfig,
          client: async () => client,
          depsDev: false,
        })

        const result = await reader.lookup('ms')

        expect(result).toMatchObject({
          ok: false,
          kind: 'request',
          reason: expect.stringContaining(expected),
        })
        expect(JSON.stringify(result)).not.toContain('SECRET')
        expect(result.ok ? '' : result.reason).toMatch(/\/…\[[0-9a-f]{6}\]\/ms/)
      },
    )

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

  describe('releaseTimes', () => {
    const packumentAccepts = (server: TestRegistry) =>
      server.requests
        .filter((r) => r.url === PACKUMENT_URL)
        .map((r) => r.headers.accept)

    const debugLines = () =>
      jest.mocked(logger.debug).mock.calls.map(([line]) => String(line))

    /** Reads the lagging deps.dev first, so the packument path is the one taken. */
    const behind = async (full?: Reply) => {
      const made = await setup({
        registry: typesMsRegistry(full),
        depsDev: laggingDepsDev(),
      })
      const looked = packageOf(await made.reader.lookup(TYPES_MS))
      return { ...made, looked }
    }

    describe('the lookup', () => {
      it("keeps deps.dev's publish times on the packument path, and none for a version it does not list", async () => {
        const { registry, looked } = await behind()

        expect(looked.source).toBe('packument')
        expect(looked.versions).toHaveLength(17)
        expect(
          looked.versions.find((v) => v.version === '0.7.34')?.publishedAt,
        ).toBe(DEPS_DEV_0_7_34)
        expect(
          looked.versions.filter((v) => v.publishedAt === undefined),
        ).toEqual([{ version: '2.1.0', deprecated: false }])
        expect(packumentAccepts(registry)).toEqual([ABBREVIATED_ACCEPT])
      })

      it('gives a packument read with deps.dev off no time from anywhere', async () => {
        const { reader } = await setup(
          { registry: typesMsRegistry() },
          { depsDev: false },
        )

        const looked = packageOf(await reader.lookup(TYPES_MS))

        expect(looked.versions.some((v) => v.publishedAt)).toBe(false)
      })
    })

    describe('a public name deps.dev lists', () => {
      it('sends no packument request for any window, or none (D2)', async () => {
        const { registry, reader } = await setup({
          registry: typesMsRegistry(),
          depsDev: replies({ [DEPS_DEV_URL]: ok('types-ms.deps-dev') }),
        })
        expect(packageOf(await reader.lookup(TYPES_MS)).source).toBe('deps.dev')

        const all = await reader.releaseTimes(TYPES_MS)
        const moving = await reader.releaseTimes(TYPES_MS, MOVING_TO_LATEST)

        expect(Object.keys(all)).toHaveLength(17)
        expect(moving).toEqual(all)
        expect(all['2.1.0']).toBe('2025-01-16T21:02:46Z')
        expect(registry.requests.map((r) => r.url)).toEqual([
          '/-/package/@types%2fms/dist-tags',
        ])
      })
    })

    describe('the window', () => {
      it('sends no full request when every version it covers has a time', async () => {
        const { registry, reader } = await behind()

        const times = await reader.releaseTimes(TYPES_MS, {
          current: '0.7.31',
          target: '0.7.34',
        })

        expect(packumentAccepts(registry)).toEqual([ABBREVIATED_ACCEPT])
        expect(times['0.7.34']).toBe(DEPS_DEV_0_7_34)
        expect(times['2.1.0']).toBeUndefined()
        expect(Object.keys(times)).toHaveLength(16)
      })

      it('reads the full packument once a version it covers has none, and its time wins', async () => {
        const { registry, reader } = await behind()

        const times = await reader.releaseTimes(TYPES_MS, MOVING_TO_LATEST)

        expect(packumentAccepts(registry)).toEqual([
          ABBREVIATED_ACCEPT,
          'application/json',
        ])
        expect(times['2.1.0']).toBe(FULL_2_1_0)
        expect(times['0.7.34']).toBe(FULL_0_7_34)
        expect(Object.keys(times)).toHaveLength(17)
        expect(debugLines()).toContain(
          'Reading the full packument of @types/ms for publish times: 2.1.0 has none',
        )
      })

      it('excludes a version at or below current, and includes the target', async () => {
        const { registry, reader } = await behind()

        await reader.releaseTimes(TYPES_MS, {
          current: '2.1.0',
          target: '2.1.0',
        })
        expect(packumentAccepts(registry)).toEqual([ABBREVIATED_ACCEPT])

        await reader.releaseTimes(TYPES_MS, {
          current: '0.7.34',
          target: '2.1.0',
        })
        expect(packumentAccepts(registry)).toHaveLength(2)
      })

      it('judges every version when a row has no installed version to start from', async () => {
        const { registry, reader } = await behind()

        await reader.releaseTimes(TYPES_MS, {
          current: 'missing',
          target: '0.7.34',
        })

        expect(packumentAccepts(registry)).toEqual([
          ABBREVIATED_ACCEPT,
          'application/json',
        ])
      })

      it('judges every version when there is no window', async () => {
        const { registry, reader } = await behind()

        const times = await reader.releaseTimes(TYPES_MS)

        expect(packumentAccepts(registry)).toHaveLength(2)
        expect(times['2.1.0']).toBe(FULL_2_1_0)
      })

      it('makes one full request for concurrent calls with different windows', async () => {
        const { registry, reader } = await behind()

        const results = await Promise.all([
          reader.releaseTimes(TYPES_MS, MOVING_TO_LATEST),
          reader.releaseTimes(TYPES_MS, { current: '0.7.0', target: '2.1.0' }),
          reader.releaseTimes(TYPES_MS),
          reader.releaseTimes(TYPES_MS, {
            current: '0.7.31',
            target: '0.7.34',
          }),
        ])
        await reader.releaseTimes(TYPES_MS, MOVING_TO_LATEST)

        expect(packumentAccepts(registry)).toEqual([
          ABBREVIATED_ACCEPT,
          'application/json',
        ])
        expect(results[0]).toEqual(results[1])
        expect(results[0]).toEqual(results[2])
        // The window with nothing to judge keeps the lookup's own times.
        expect(results[3]['0.7.34']).toBe(DEPS_DEV_0_7_34)
      })
    })

    describe('what the full packument adds', () => {
      it('counts only the versions it lists, not created, modified or an unpublished version', async () => {
        const { reader, looked } = await behind({
          body: derive<{ versions: Record<string, unknown> }>(
            'types-ms.packument-full',
            (body) => {
              // The version is gone; the registry keeps its `time` entry.
              delete body.versions['2.1.0']
            },
          ),
        })

        const times = await reader.releaseTimes(TYPES_MS, MOVING_TO_LATEST)

        expect(times['2.1.0']).toBeUndefined()
        expect('created' in times).toBe(false)
        expect('modified' in times).toBe(false)
        expect(Object.keys(times).sort()).toEqual(
          looked.versions
            .map((v) => v.version)
            .filter((v) => v !== '2.1.0')
            .sort(),
        )
      })

      it('gives every version a time when deps.dev is off', async () => {
        const { registry, reader } = await setup(
          { registry: typesMsRegistry() },
          { depsDev: false },
        )
        await reader.lookup(TYPES_MS)

        const times = await reader.releaseTimes(TYPES_MS)

        expect(Object.keys(times)).toHaveLength(17)
        expect(times['0.7.15-alpha']).toBe('2016-05-17T18:23:02.430Z')
        expect(packumentAccepts(registry)).toEqual([
          ABBREVIATED_ACCEPT,
          'application/json',
        ])
        expect(debugLines()).toContain(
          'Reading the full packument of @types/ms for publish times: 0.7.15-alpha, 0.7.16-alpha, 0.7.21-alpha and 14 more have none',
        )
      })
    })

    describe('failures', () => {
      it.each([
        ['a server error', { status: 500, body: 'oops' }],
        ['a body that is not JSON', { body: '<html>' }],
      ] as Array<[string, Reply]>)(
        'keeps the lookup times and says why after %s',
        async (_label, full) => {
          const { reader } = await behind(full)

          const times = await reader.releaseTimes(TYPES_MS, MOVING_TO_LATEST)

          expect(Object.keys(times)).toHaveLength(16)
          expect(times['0.7.34']).toBe(DEPS_DEV_0_7_34)
          expect(debugLines()).toContainEqual(
            expect.stringMatching(
              /^Failed to read the full packument of @types\/ms: /,
            ),
          )
        },
      )

      it('keeps the lookup times when the registry cannot be reached', async () => {
        const { registry, reader } = await behind()
        await registry.close()

        const times = await reader.releaseTimes(TYPES_MS, MOVING_TO_LATEST)

        expect(Object.keys(times)).toHaveLength(16)
        expect(debugLines()).toContainEqual(
          expect.stringMatching(
            /^Failed to read the full packument of @types\/ms: /,
          ),
        )
      })

      it('keeps the lookup times, and never rejects, when reading the full packument throws', async () => {
        // A cache whose write of the full document throws: a failure outside the request.
        const cache: RegistryCache = {
          dir: '',
          get: () => undefined,
          put: (kind) => {
            if (kind === 'packument-full') throw new Error('disk on fire')
            return false
          },
          stats: () => ({
            fresh: 0,
            stale: 0,
            missing: 0,
            written: 0,
            failedWrites: 0,
            pruned: 0,
          }),
          close: () => undefined,
        }
        const { reader } = await setup(
          { registry: typesMsRegistry(), depsDev: laggingDepsDev() },
          { cache },
        )
        await reader.lookup(TYPES_MS)

        const first = await reader.releaseTimes(TYPES_MS, MOVING_TO_LATEST)
        const again = await reader.releaseTimes(TYPES_MS, MOVING_TO_LATEST)

        expect(Object.keys(first)).toHaveLength(16)
        expect(first['0.7.34']).toBe(DEPS_DEV_0_7_34)
        expect(again).toEqual(first)
        expect(debugLines()).toContainEqual(
          'Failed to read the full packument of @types/ms: disk on fire',
        )
      })

      it('keeps the lookup times when the document is not a packument', async () => {
        const { reader } = await behind({
          body: derive<{ versions?: unknown }>(
            'types-ms.packument-full',
            (body) => {
              delete body.versions
            },
          ),
        })

        const times = await reader.releaseTimes(TYPES_MS, MOVING_TO_LATEST)

        expect(Object.keys(times)).toHaveLength(16)
        expect(debugLines()).toContainEqual(
          expect.stringMatching(/sent an unreadable document for @types\/ms$/),
        )
      })

      it('does not ask again after a failed read: the answer is memoized for the run', async () => {
        const { registry, reader } = await behind({ status: 500, body: 'oops' })

        await reader.releaseTimes(TYPES_MS, MOVING_TO_LATEST)
        await reader.releaseTimes(TYPES_MS)

        expect(packumentAccepts(registry)).toEqual([
          ABBREVIATED_ACCEPT,
          'application/json',
        ])
      })

      it('answers {} for a name whose lookup failed, without a request of its own', async () => {
        const { registry, reader } = await setup({ registry: status500 })
        const lookedUp = await reader.lookup(TYPES_MS)
        expect(lookedUp.ok).toBe(false)
        const before = registry.requests.length

        expect(await reader.releaseTimes(TYPES_MS)).toEqual({})
        expect(await reader.releaseTimes(TYPES_MS, MOVING_TO_LATEST)).toEqual(
          {},
        )

        expect(registry.requests).toHaveLength(before)
      })
    })

    it('keeps full packuments within maxSockets in flight to one host, as every other request is (D5)', async () => {
      const combined = await start((req, res) => {
        setTimeout(() => {
          res.setHeader('content-type', 'application/json')
          res.end(
            registryBody(
              req.headers.accept === ABBREVIATED_ACCEPT
                ? 'types-ms.packument'
                : 'types-ms.packument-full',
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
        depsDev: false,
      })
      const names = Array.from({ length: 5 }, (_, i) => `pkg-${i}`)
      await Promise.all(names.map((name) => reader.lookup(name)))

      const results = await Promise.all(
        names.map((name) => reader.releaseTimes(name)),
      )

      expect(results.every((times) => Object.keys(times).length === 17)).toBe(
        true,
      )
      expect(
        accepts(combined).filter((a) => a === 'application/json'),
      ).toHaveLength(5)
      expect(combined.peak).toBe(2)
    })
  })

  describe('versionManifest (#196)', () => {
    const manifestOf = (capture: string) => ({ body: registryBody(capture) })
    const MS_2_1_3 = parseVersionManifest(
      JSON.parse(registryBody('ms.2.1.3.manifest')),
      { name: 'ms', version: '2.1.3' },
    )
    /** `ms`'s dist-tags and packument, plus its version manifests by version. */
    const msWith = (manifests: Record<string, Reply | Handler>): Handler => {
      const base = msRegistry()
      return (req, res) => {
        const version = req.url?.startsWith('/ms/')
          ? req.url.slice('/ms/'.length)
          : undefined
        const answer = version === undefined ? undefined : manifests[version]
        if (answer === undefined) return base(req, res)
        if (typeof answer === 'function') return answer(req, res)
        return replies({ [req.url ?? '']: answer })(req, res)
      }
    }
    const manifestRequests = (server: TestRegistry): string[] =>
      server.requests
        .map((r) => r.url)
        .filter((url) => /^\/(@[^/]+%2f)?[^/]+\/[^/]+$/.test(url))
    const debugLines = (): string[] =>
      jest.mocked(logger.debug).mock.calls.map(([line]) => String(line))

    it('reads a listed version with one request', async () => {
      const { registry, reader } = await setup({
        registry: msWith({ '2.1.3': manifestOf('ms.2.1.3.manifest') }),
      })

      expect(await reader.versionManifest('ms', '2.1.3')).toEqual(MS_2_1_3)
      expect(manifestRequests(registry)).toEqual(['/ms/2.1.3'])
      expect(
        registry.requests.find((r) => r.url === '/ms/2.1.3')?.headers.accept,
      ).toBe('application/json')
    })

    it('asks once per name and version, concurrent or later', async () => {
      const { registry, reader } = await setup({
        registry: msWith({
          '2.1.3': manifestOf('ms.2.1.3.manifest'),
          '0.1.0': manifestOf('ms.0.1.0.manifest'),
        }),
      })

      const [first, second, other] = await Promise.all([
        reader.versionManifest('ms', '2.1.3'),
        reader.versionManifest('ms', '2.1.3'),
        reader.versionManifest('ms', '0.1.0'),
      ])
      const later = await reader.versionManifest('ms', '2.1.3')

      expect(second).toBe(first)
      expect(later).toBe(first)
      expect(other).toMatchObject({ version: '0.1.0', enginesNode: '*' })
      expect(manifestRequests(registry).sort()).toEqual([
        '/ms/0.1.0',
        '/ms/2.1.3',
      ])
    })

    it('remembers a failure for the run, with a debug line', async () => {
      const { registry, reader } = await setup({
        registry: msWith({ '2.1.3': status500 }),
      })

      expect(await reader.versionManifest('ms', '2.1.3')).toBeUndefined()
      expect(await reader.versionManifest('ms', '2.1.3')).toBeUndefined()
      expect(manifestRequests(registry)).toEqual(['/ms/2.1.3'])
      expect(
        debugLines().some((line) =>
          line.startsWith('Failed to read the manifest of ms@2.1.3: '),
        ),
      ).toBe(true)
    })

    it('is undefined for a 404, whose body is a JSON string', async () => {
      const { registry, reader } = await setup({
        registry: msWith({
          '2.1.3': {
            status: 404,
            body: registryBody('ms.0.0.0-autd-no-such-version.manifest'),
          },
        }),
      })

      expect(await reader.versionManifest('ms', '2.1.3')).toBeUndefined()
      expect(debugLines()).toContain(
        `ms@2.1.3 has no manifest on 127.0.0.1:${registry.port}`,
      )
    })

    it.each([
      ['a JSON string', registryBody('ms.0.0.0-autd-no-such-version.manifest')],
      ['another version', registryBody('ms.0.1.0.manifest')],
    ])('is undefined for a 200 that is %s', async (_label, body) => {
      const { registry, reader } = await setup({
        registry: msWith({ '2.1.3': { body } }),
      })

      expect(await reader.versionManifest('ms', '2.1.3')).toBeUndefined()
      expect(debugLines()).toContain(
        `127.0.0.1:${registry.port} sent an unreadable manifest for ms@2.1.3`,
      )
    })

    it('asks nothing for a version the lookup does not list', async () => {
      const { registry, reader } = await setup({ registry: msWith({}) })

      expect(await reader.versionManifest('ms', '9.9.9')).toBeUndefined()
      expect(manifestRequests(registry)).toEqual([])
    })

    it('asks nothing when the lookup failed', async () => {
      const { registry, reader } = await setup({
        registry: replies({}),
        depsDev: replies({}),
      })

      expect(await reader.versionManifest('ms', '2.1.3')).toBeUndefined()
      expect(manifestRequests(registry)).toEqual([])
    })

    it.each([
      ['an invalid name', '../ms', '2.1.3'],
      ['a version that is not semver', 'ms', 'latest'],
      ['a version that is not canonical', 'ms', 'v2.1.3'],
    ])('asks nothing at all for %s', async (_label, name, version) => {
      const { registry, depsDev, reader } = await setup({
        registry: msWith({}),
      })

      expect(await reader.versionManifest(name, version)).toBeUndefined()
      expect(registry.requests).toEqual([])
      expect(depsDev.requests).toEqual([])
    })

    it("escapes a scoped name's slash and sends the registry's credentials", async () => {
      const registry = await start(
        replies({
          [PACKUMENT_URL]: packument('types-ms.packument'),
          [`${PACKUMENT_URL}/2.1.0`]: manifestOf('types-ms.2.1.0.manifest'),
        }),
      )
      const config = configFor(registry.url, {
        credentials: {
          [`//127.0.0.1:${registry.port}/`]: { authToken: 'TOK' },
        },
      })
      const client = createRegistryClient(config)
      clients.push(client)
      const reader = createRegistryReader({
        registryConfig: config,
        client: async () => client,
        depsDev: false,
      })

      expect(await reader.versionManifest(TYPES_MS, '2.1.0')).toEqual({
        name: TYPES_MS,
        version: '2.1.0',
        license: 'MIT',
        peerDependencies: {},
        optionalPeers: [],
        dependencies: {},
        optionalDependencies: {},
        deprecated: false,
      })
      const sent = registry.requests.find(
        (r) => r.url === `${PACKUMENT_URL}/2.1.0`,
      )
      expect(sent?.headers.authorization).toBe('Bearer TOK')
    })

    it("takes the lookup's deprecation over the manifest's", async () => {
      const staleManifest = derive<Record<string, unknown>>(
        'ms.2.1.3.manifest',
        (body) => {
          body.deprecated = 'the manifest says so'
        },
      )
      const deprecatedByDepsDev = derive<{
        versions: Array<{
          versionKey: { version: string }
          isDeprecated?: boolean
          deprecatedReason?: string
        }>
      }>('ms.deps-dev', (body) => {
        for (const v of body.versions) {
          if (v.versionKey.version === '0.1.0') {
            v.isDeprecated = true
            v.deprecatedReason = 'deps.dev says so'
          }
        }
      })
      const { reader } = await setup({
        registry: msWith({
          '2.1.3': { body: staleManifest },
          '0.1.0': manifestOf('ms.0.1.0.manifest'),
        }),
        depsDev: replies({
          [`${DEPS_DEV_PREFIX}ms`]: { body: deprecatedByDepsDev },
        }),
      })

      const live = await reader.versionManifest('ms', '2.1.3')
      expect(live?.deprecated).toBe(false)
      expect(live).not.toHaveProperty('deprecatedReason')
      expect(await reader.versionManifest('ms', '0.1.0')).toMatchObject({
        deprecated: true,
        deprecatedReason: 'deps.dev says so',
      })
    })

    it('keeps no more than maxSockets manifest requests in flight to one host', async () => {
      const versions = ['0.1.0', '0.2.0', '0.3.0', '0.4.0', '0.5.0', '0.6.0']
      const slow: Handler = (req, res) => {
        const version = req.url?.slice('/ms/'.length) ?? ''
        setTimeout(() => {
          res.setHeader('content-type', 'application/json')
          res.end(
            derive<Record<string, unknown>>('ms.0.1.0.manifest', (body) => {
              body.version = version
            }),
          )
        }, 20)
      }
      const { registry, reader } = await setup(
        {
          registry: msWith(Object.fromEntries(versions.map((v) => [v, slow]))),
        },
        { config: { maxSockets: 2 } },
      )
      await reader.lookup('ms')
      registry.peak = 0

      const read = await Promise.all(
        versions.map((v) => reader.versionManifest('ms', v)),
      )

      expect(read.map((m) => m?.version)).toEqual(versions)
      expect(registry.peak).toBe(2)
    })
  })

  describe('with the disk cache', () => {
    const START = Date.UTC(2026, 9, 27)
    const SECOND = 1000
    let dir: string
    let clock: number

    beforeEach(() => {
      dir = tempDir('autd-reader-cache-', { real: true })
      clock = START
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

        it('asks nothing while a fresh packument lists it', async () => {
          const { run, asked } = await cached({
            registry: msRegistry(),
            depsDev: replies({
              [`${DEPS_DEV_PREFIX}ms`]: { body: lacksLatest },
            }),
          })
          const first = packageOf(await run().reader.lookup('ms'))
          expect(first.source).toBe('packument')
          asked()

          clock += 299 * SECOND
          const second = run()
          const result = packageOf(await second.reader.lookup('ms'))

          expect(result).toEqual(first)
          expect(asked()).toEqual({ registry: [], depsDev: [] })
          expect(second.clientsMade()).toBe(0)
        })

        it('counts that packument entry once', async () => {
          const { run } = await cached({
            registry: msRegistry(),
            depsDev: replies({
              [`${DEPS_DEV_PREFIX}ms`]: { body: lacksLatest },
            }),
          })
          await run().reader.lookup('ms')

          clock += 299 * SECOND
          const second = run()
          await second.reader.lookup('ms')

          // dist-tags, deps.dev and the packument.
          expect(second.cache.stats().fresh).toBe(3)
        })

        it('asks deps.dev once more when the packument has gone stale, and uses what it now lists', async () => {
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

          clock += 301 * SECOND
          const result = packageOf(await run().reader.lookup('ms'))

          expect(result.source).toBe('deps.dev')
          expect(asked()).toEqual({
            registry: ['/-/package/ms/dist-tags'],
            depsDev: [`${DEPS_DEV_PREFIX}ms`],
          })
        })

        it('asks deps.dev once more when the fresh packument lacks it too, as a proxy that hides fresh versions leaves it', async () => {
          const hidden = derive<{
            versions: Record<string, unknown>
            'dist-tags': { latest: string }
          }>('ms.packument', (body) => {
            delete body.versions['2.1.3']
            body['dist-tags'].latest = '2.1.2'
          })
          const { run, asked } = await cached({
            registry: replies({
              '/-/package/ms/dist-tags': ok('ms.dist-tags'),
              '/ms': {
                body: hidden,
                type: 'application/vnd.npm.install-v1+json',
              },
            }),
            depsDev: replies({
              [`${DEPS_DEV_PREFIX}ms`]: { body: lacksLatest },
            }),
          })
          await run().reader.lookup('ms')
          asked()

          clock += 10 * SECOND
          const result = packageOf(await run().reader.lookup('ms'))

          expect(result.source).toBe('packument')
          expect(result.latest).toBe('2.1.2')
          expect(asked()).toEqual({
            registry: ['/ms'],
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

    describe('publish times from the full packument', () => {
      const lagged = (
        full?: Reply | Handler,
        options: { credentials?: boolean; cacheDir?: string } = {},
      ) =>
        cached(
          { registry: typesMsRegistry(full), depsDev: laggingDepsDev() },
          options,
        )

      /** What the gate and the cooldown do in one run: look up, then ask about a move to 2.1.0. */
      const gate = async (reader: RegistryReader) => {
        await reader.lookup(TYPES_MS)
        return reader.releaseTimes(TYPES_MS, MOVING_TO_LATEST)
      }

      /** The full-packument requests the registry took since the last call. */
      const fullRequests = (registry: TestRegistry) =>
        registry.requests
          .splice(0)
          .filter(
            (r) =>
              r.url === PACKUMENT_URL &&
              r.headers.accept !== ABBREVIATED_ACCEPT,
          )

      const readingLines = () =>
        jest
          .mocked(logger.debug)
          .mock.calls.map(([line]) => String(line))
          .filter((line) => line.startsWith('Reading the full packument'))

      const revalidatedLines = () =>
        jest
          .mocked(logger.debug)
          .mock.calls.map(([line]) => String(line))
          .filter((line) => line.startsWith('Revalidated the full packument'))

      const without = (version: string) =>
        derive<{ versions: Record<string, unknown> }>(
          'types-ms.packument-full',
          (body) => {
            delete body.versions[version]
          },
        )

      it('stores the document, and answers later runs from it at any age without a request or a log line', async () => {
        const { registry, run } = await lagged()
        const first = await gate(run().reader)
        expect(first['2.1.0']).toBe(FULL_2_1_0)
        expect(fullRequests(registry)).toHaveLength(1)
        expect(filesIn('packument-full')).toHaveLength(1)

        clock += 60 * SECOND
        expect(await gate(run().reader)).toEqual(first)
        expect(fullRequests(registry)).toHaveLength(0)

        clock += 301 * SECOND
        const third = run()
        expect(await gate(third.reader)).toEqual(first)
        expect(fullRequests(registry)).toHaveLength(0)
        expect(third.reader.stats().notModified).toBe(0)
        expect(readingLines()).toHaveLength(1)
      })

      it.each([
        ['fresh', 10],
        ['300 seconds old and more', 301],
      ])(
        'asks again, with If-None-Match, when a %s document lacks a version it needs, and the 200 replaces it',
        async (_label, later) => {
          const side = switchable(
            conditional({ body: without('2.1.0') }, 'W/"one"'),
          )
          const { registry, run } = await lagged(side.handler)
          const first = await gate(run().reader)
          expect(first['2.1.0']).toBeUndefined()
          expect(fullRequests(registry)).toHaveLength(1)
          side.use(conditional(ok('types-ms.packument-full'), 'W/"two"'))

          clock += later * SECOND
          const second = await gate(run().reader)
          const asked = fullRequests(registry)
          expect(asked.map((r) => r.headers['if-none-match'])).toEqual([
            'W/"one"',
          ])
          expect(second['2.1.0']).toBe(FULL_2_1_0)

          clock += 301 * SECOND
          expect(await gate(run().reader)).toEqual(second)
          expect(fullRequests(registry)).toHaveLength(0)
          expect(readingLines()).toHaveLength(2)
        },
      )

      it('keeps the document when the registry confirms it with a 304, and the version stays unknown', async () => {
        const { registry, run } = await lagged(
          conditional({ body: without('2.1.0') }, 'W/"one"'),
        )
        await gate(run().reader)
        fullRequests(registry)

        clock += 10 * SECOND
        const second = run()
        const times = await gate(second.reader)

        expect(times['2.1.0']).toBeUndefined()
        expect(
          fullRequests(registry).map((r) => r.headers['if-none-match']),
        ).toEqual(['W/"one"'])
        expect(second.reader.stats().notModified).toBe(1)
      })

      it('drops a stored version the lookup no longer lists, so a fallback never lands on an unpublished one', async () => {
        const side = switchable(typesMsRegistry())
        const { registry, run } = await cached({
          registry: side.handler,
          depsDev: laggingDepsDev(),
        })
        const first = await gate(run().reader)
        expect(first['0.7.33']).toBeDefined()
        fullRequests(registry)
        // 0.7.33 is unpublished: the abbreviated packument drops it, and the
        // stored full one, which still covers 2.1.0, lists it.
        side.use(
          typesMsRegistry(ok('types-ms.packument-full'), {
            body: derive<{ versions: Record<string, unknown> }>(
              'types-ms.packument',
              (body) => {
                delete body.versions['0.7.33']
              },
            ),
            type: 'application/vnd.npm.install-v1+json',
          }),
        )

        clock += 301 * SECOND
        const times = await gate(run().reader)

        expect(fullRequests(registry)).toHaveLength(0)
        expect(times['0.7.33']).toBeUndefined()
        expect(times['2.1.0']).toBe(FULL_2_1_0)
        expect(Object.keys(times)).toHaveLength(16)
      })

      it('treats a version the document lists without a time as a known gap, not a reason to ask again', async () => {
        const noTime = derive<{ time: Record<string, string> }>(
          'types-ms.packument-full',
          (body) => {
            delete body.time['2.1.0']
          },
        )
        const { registry, run } = await lagged({ body: noTime })
        const first = await gate(run().reader)
        expect(first['2.1.0']).toBeUndefined()
        expect(fullRequests(registry)).toHaveLength(1)

        clock += 301 * SECOND
        expect(await gate(run().reader)).toEqual(first)
        expect(fullRequests(registry)).toHaveLength(0)
      })

      it('asks again on every run for an authenticated registry, with the ETag, and a 304 serves the times', async () => {
        const { registry, run } = await lagged(
          conditional(ok('types-ms.packument-full'), 'W/"auth"'),
          { credentials: true },
        )
        const first = await gate(run().reader)
        clock += SECOND
        const second = run()
        const times = await gate(second.reader)
        clock += SECOND
        await gate(run().reader)

        expect(times).toEqual(first)
        expect(times['2.1.0']).toBe(FULL_2_1_0)
        expect(
          fullRequests(registry).map((r) => r.headers['if-none-match']),
        ).toEqual([undefined, 'W/"auth"', 'W/"auth"'])
        expect(second.reader.stats().notModified).toBe(1)
      })

      it('logs a 304 as a revalidation, since no document was read (#176)', async () => {
        const { run } = await lagged(
          conditional(ok('types-ms.packument-full'), 'W/"auth"'),
          { credentials: true },
        )
        await gate(run().reader)
        expect(readingLines()).toHaveLength(1)
        expect(revalidatedLines()).toEqual([])

        clock += SECOND
        await gate(run().reader)

        expect(readingLines()).toHaveLength(1)
        expect(revalidatedLines()).toEqual([
          'Revalidated the full packument of @types/ms for publish times (304): 2.1.0 has none',
        ])
      })

      it('logs no read for a request that failed (#176)', async () => {
        const { run } = await lagged(status(404))

        await gate(run().reader)

        expect(readingLines()).toEqual([])
        expect(revalidatedLines()).toEqual([])
      })

      it('counts a stored document that answers past its TTL as covered, and one inside it as not (#176)', async () => {
        const { run } = await lagged()
        const first = run()
        await gate(first.reader)
        expect(first.reader.stats().covered).toBe(0)

        clock += 60 * SECOND
        const inside = run()
        await gate(inside.reader)
        expect(inside.reader.stats().covered).toBe(0)

        clock += 301 * SECOND
        const past = run()
        await gate(past.reader)
        // Once per name per run, however many times the run asks.
        await past.reader.releaseTimes(TYPES_MS)
        expect(past.reader.stats().covered).toBe(1)
      })

      it('asks again on every run when the registry said no-cache, as it does for a lookup', async () => {
        const { registry, run } = await lagged(
          conditional(
            {
              ...ok('types-ms.packument-full'),
              headers: { 'cache-control': 'no-cache' },
            },
            'W/"fresh"',
          ),
        )
        await gate(run().reader)
        clock += SECOND
        await gate(run().reader)
        clock += SECOND
        await gate(run().reader)

        expect(
          fullRequests(registry).map((r) => r.headers['if-none-match']),
        ).toEqual([undefined, 'W/"fresh"', 'W/"fresh"'])
      })

      it('keeps no token, endpoint or URL in any stored file', async () => {
        const { registry, run } = await lagged(
          conditional(ok('types-ms.packument-full'), 'W/"auth"'),
          { credentials: true },
        )
        await gate(run().reader)

        const files = (
          fs.readdirSync(path.join(dir, 'v1'), { recursive: true }) as string[]
        ).filter((file) => file.endsWith('.json.gz'))
        expect(files.length).toBeGreaterThan(2)
        for (const file of files) {
          const text = zlib
            .gunzipSync(fs.readFileSync(path.join(dir, 'v1', file)))
            .toString()
          expect(text).not.toContain('TOK')
          expect(text).not.toContain(registry.url)
          expect(text).not.toContain(`127.0.0.1:${registry.port}`)
        }
      })

      it('gives the same times when the folder cannot be written, asking every run', async () => {
        const file = path.join(dir, 'in-the-way')
        fs.writeFileSync(file, 'a file, not a folder')
        const { registry, run } = await lagged(undefined, { cacheDir: file })

        const first = await gate(run().reader)
        const second = await gate(run().reader)

        expect(first['2.1.0']).toBe(FULL_2_1_0)
        expect(second).toEqual(first)
        expect(fullRequests(registry)).toHaveLength(2)
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

      it('asks again even when the registry says public: that says nothing about who else may see it', async () => {
        const { registry, run, asked } = await cached(
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

        expect(asked().registry).toEqual(['/ms'])
        expect(registry.requests).toEqual([])
      })
    })

    describe('version manifests (#196)', () => {
      const DAY = 24 * 60 * 60 * SECOND
      const manifestReply = (headers: Record<string, string> = {}): Reply => ({
        body: registryBody('ms.2.1.3.manifest'),
        headers,
      })
      /** `ms`'s lookup documents, and `handler` for `/ms/2.1.3`. */
      const msAnd = (manifest: Reply | Handler): Handler => {
        const base = msRegistry()
        const answer =
          typeof manifest === 'function'
            ? manifest
            : replies({ '/ms/2.1.3': manifest })
        return (req, res) => (req.url === '/ms/2.1.3' ? answer : base)(req, res)
      }
      const manifestAsked = (urls: string[]) =>
        urls.filter((url) => url === '/ms/2.1.3')

      it('answers a later run from the entry however old it is, as covered', async () => {
        const { run, asked } = await cached({
          registry: msAnd(manifestReply({ 'cache-control': 'max-age=300' })),
        })
        const first = await run().reader.versionManifest('ms', '2.1.3')
        expect(manifestAsked(asked().registry)).toEqual(['/ms/2.1.3'])
        expect(filesIn('manifest')).toHaveLength(1)

        clock += 30 * DAY
        const second = run()
        expect(await second.reader.versionManifest('ms', '2.1.3')).toEqual(
          first,
        )
        expect(manifestAsked(asked().registry)).toEqual([])
        expect(second.reader.stats().covered).toBe(1)
      })

      it('answers inside the TTL without counting it covered', async () => {
        const { run, asked } = await cached({
          registry: msAnd(manifestReply()),
        })
        await run().reader.versionManifest('ms', '2.1.3')
        asked()

        clock += 10 * SECOND
        const second = run()
        await second.reader.versionManifest('ms', '2.1.3')
        expect(asked()).toEqual({ registry: [], depsDev: [] })
        expect(second.reader.stats().covered).toBe(0)
      })

      it("takes a later lookup's deprecation over the stored manifest's", async () => {
        const depsDev = switchable(msDepsDev())
        const { run } = await cached({
          registry: msAnd(manifestReply()),
          depsDev: depsDev.handler,
        })
        expect(
          (await run().reader.versionManifest('ms', '2.1.3'))?.deprecated,
        ).toBe(false)

        depsDev.use(
          replies({
            [`${DEPS_DEV_PREFIX}ms`]: {
              body: derive<{
                versions: Array<{
                  versionKey: { version: string }
                  isDeprecated?: boolean
                  deprecatedReason?: string
                }>
              }>('ms.deps-dev', (body) => {
                for (const v of body.versions) {
                  if (v.versionKey.version === '2.1.3') {
                    v.isDeprecated = true
                    v.deprecatedReason = 'use 3'
                  }
                }
              }),
            },
          }),
        )
        clock += 2 * 3600 * SECOND
        expect(await run().reader.versionManifest('ms', '2.1.3')).toMatchObject(
          { deprecated: true, deprecatedReason: 'use 3' },
        )
      })

      it('revalidates an authenticated entry every run when deps.dev does not vouch for the package, and a 304 serves it', async () => {
        const { registry, run } = await cached(
          { registry: msAnd(conditional(manifestReply(), '"m1"')) },
          { depsDev: false, credentials: true },
        )
        const first = await run().reader.versionManifest('ms', '2.1.3')
        clock += 30 * DAY
        const second = run()
        expect(await second.reader.versionManifest('ms', '2.1.3')).toEqual(
          first,
        )

        expect(
          registry.requests
            .filter((r) => r.url === '/ms/2.1.3')
            .map((r) => r.headers['if-none-match']),
        ).toEqual([undefined, '"m1"'])
        expect(second.reader.stats().notModified).toBeGreaterThanOrEqual(1)
        expect(second.reader.stats().covered).toBe(0)
      })

      it('keeps no authenticated manifest without an ETag when deps.dev does not vouch for the package, so each run asks again', async () => {
        const { run, asked } = await cached(
          {
            registry: msAnd(manifestReply({ 'cache-control': 'max-age=300' })),
          },
          { depsDev: false, credentials: true },
        )
        await run().reader.versionManifest('ms', '2.1.3')
        expect(filesIn('manifest')).toEqual([])
        asked()

        clock += SECOND
        await run().reader.versionManifest('ms', '2.1.3')
        expect(manifestAsked(asked().registry)).toEqual(['/ms/2.1.3'])
      })

      it('stores nothing under no-store', async () => {
        const { run, asked } = await cached({
          registry: msAnd(manifestReply({ 'cache-control': 'no-store' })),
        })
        await run().reader.versionManifest('ms', '2.1.3')
        expect(filesIn('manifest')).toEqual([])
        asked()

        await run().reader.versionManifest('ms', '2.1.3')
        expect(manifestAsked(asked().registry)).toEqual(['/ms/2.1.3'])
      })

      it('keeps an authenticated manifest of a package deps.dev lists, as npmjs answers it, and reuses it with no request', async () => {
        const { run, asked } = await cached(
          {
            registry: msAnd(manifestReply({ 'cache-control': 'max-age=300' })),
          },
          { credentials: true },
        )
        const first = await run().reader.versionManifest('ms', '2.1.3')
        expect(filesIn('manifest')).toHaveLength(1)
        asked()

        clock += 30 * DAY
        const second = run()
        expect(await second.reader.versionManifest('ms', '2.1.3')).toEqual(
          first,
        )
        expect(manifestAsked(asked().registry)).toEqual([])
        expect(second.reader.stats().covered).toBe(1)
      })

      it('never falls back to a stored entry it must revalidate when the request fails', async () => {
        const registry = switchable(msAnd(conditional(manifestReply(), '"m1"')))
        const { run } = await cached(
          { registry: registry.handler },
          { depsDev: false, credentials: true },
        )
        await run().reader.versionManifest('ms', '2.1.3')
        registry.use(msAnd(status(500)))

        clock += SECOND
        expect(
          await run().reader.versionManifest('ms', '2.1.3'),
        ).toBeUndefined()
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

      /** 200 with `first`'s headers; a 304 carrying only `notModified`'s. */
      const validating =
        (
          first: Record<string, string>,
          notModified: Record<string, string> = {},
        ): Handler =>
        (req, res) => {
          const headers = req.headers['if-none-match']
            ? notModified
            : { ...first }
          res.statusCode = req.headers['if-none-match'] ? 304 : 200
          res.setHeader('etag', 'W/"v"')
          res.setHeader('content-type', 'application/json')
          for (const [name, value] of Object.entries(headers)) {
            res.setHeader(name, value)
          }
          res.end(
            req.headers['if-none-match']
              ? undefined
              : registryBody('ms.packument'),
          )
        }

      it('keeps no-cache through a 304 that does not repeat it', async () => {
        const { run, asked } = await cached(
          { registry: validating({ 'cache-control': 'no-cache' }) },
          { depsDev: false },
        )
        await run().reader.lookup('ms')
        asked()

        clock += SECOND
        await run().reader.lookup('ms')
        expect(asked().registry).toEqual(['/ms'])

        clock += SECOND
        await run().reader.lookup('ms')
        expect(asked().registry).toEqual(['/ms'])
      })

      it('keeps a short max-age through a 304 that does not repeat it', async () => {
        const { run, asked } = await cached(
          { registry: validating({ 'cache-control': 'max-age=60' }) },
          { depsDev: false },
        )
        await run().reader.lookup('ms')
        asked()

        clock += 61 * SECOND
        await run().reader.lookup('ms')
        expect(asked().registry).toEqual(['/ms'])

        clock += 59 * SECOND
        await run().reader.lookup('ms')
        expect(asked().registry).toEqual([])

        clock += 2 * SECOND
        await run().reader.lookup('ms')
        expect(asked().registry).toEqual(['/ms'])
      })

      it("takes a 304's own Cache-Control over the stored one", async () => {
        const { run, asked } = await cached(
          {
            registry: validating(
              { 'cache-control': 'max-age=60' },
              { 'cache-control': 'max-age=200' },
            ),
          },
          { depsDev: false },
        )
        await run().reader.lookup('ms')
        clock += 61 * SECOND
        await run().reader.lookup('ms')
        asked()

        clock += 199 * SECOND
        await run().reader.lookup('ms')
        expect(asked().registry).toEqual([])
      })

      it('counts Age against the freshness', async () => {
        const { run, asked } = await cached(
          {
            registry: replies({
              '/ms': {
                ...packument('ms.packument'),
                headers: { 'cache-control': 'public, max-age=300', age: '100' },
              },
            }),
          },
          { depsDev: false },
        )
        await run().reader.lookup('ms')
        asked()

        clock += 199 * SECOND
        await run().reader.lookup('ms')
        expect(asked().registry).toEqual([])

        clock += 2 * SECOND
        await run().reader.lookup('ms')
        expect(asked().registry).toEqual(['/ms'])
      })

      it("counts a 304's Age, not the stored one", async () => {
        const { run, asked } = await cached(
          {
            registry: validating(
              { 'cache-control': 'public, max-age=300', age: '250' },
              { age: '100' },
            ),
          },
          { depsDev: false },
        )
        await run().reader.lookup('ms')
        clock += 51 * SECOND
        await run().reader.lookup('ms')
        asked()

        clock += 199 * SECOND
        await run().reader.lookup('ms')
        expect(asked().registry).toEqual([])

        clock += 2 * SECOND
        await run().reader.lookup('ms')
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
