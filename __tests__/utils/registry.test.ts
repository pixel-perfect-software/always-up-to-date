jest.mock('@/utils/logger')

import fs from 'fs'
import os from 'os'
import path from 'path'
import type { ManagerAdapter } from '@/managers/adapter'
import bun from '@/managers/bun'
import pnpm from '@/managers/pnpm'
import type { PackageLookup, RegistryConfig, ReleaseAgeGate } from '@/types'
import logger from '@/utils/logger'
import { managerRegistryConfig, type NpmrcSources } from '@/utils/npmrcLoader'
import { createRegistrySession, type RegistrySession } from '@/utils/registry'
import { createRegistryCache } from '@/utils/registryCache'
import type { RegistryClient } from '@/utils/registryClient'
import { type ParsedPackument, parsePackument } from '@/utils/registryDocuments'
import { ABBREVIATED_ACCEPT } from '@/utils/registryRequest'
import { withReleaseAgeGate } from '@/utils/releaseAgeGate'
import {
  conditional,
  derive,
  type Handler,
  registryBody,
  replies,
  startRegistry,
  type TestRegistry,
} from '../fixtures/registry'

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

/**
 * `@types/ms` on a registry that answers the abbreviated packument and the
 * full one by `Accept`, whatever name was asked for: what an npm-compatible
 * registry does for a name deps.dev never saw.
 */
const typesMs: Handler = (req, res) => {
  res.setHeader('content-type', 'application/json')
  res.end(
    registryBody(
      req.headers.accept === ABBREVIATED_ACCEPT
        ? 'types-ms.packument'
        : 'types-ms.packument-full',
    ),
  )
}

/** The full packument's time for @types/ms 2.1.0. */
const FULL_2_1_0 = '2025-01-16T21:02:46.181Z'

const status =
  (code: number): Handler =>
  (_req, res) => {
    res.statusCode = code
    res.end('failed')
  }

describe('registry session', () => {
  const servers: TestRegistry[] = []
  const start = async (handler: Parameters<typeof startRegistry>[0]) => {
    const server = await startRegistry(handler)
    servers.push(server)
    return server
  }

  const sessions: RegistrySession[] = []
  const sessionFor = (config: RegistryConfig) => {
    const session = createRegistrySession('/project', {
      loadConfig: () => config,
    })
    sessions.push(session)
    return session
  }

  afterEach(async () => {
    for (const session of sessions.splice(0)) session.close()
    await Promise.all(servers.splice(0).map((s) => s.close()))
  })

  it('reads the full packument once while several manifests ask for a package at the same time', async () => {
    const server = await start(typesMs)
    const session = sessionFor(configFor(server.url))

    const times = await Promise.all([
      session.releaseTimes('@types/ms'),
      session.releaseTimes('@types/ms'),
      session.releaseTimes('@types/ms'),
    ])

    // The lookup, then the one full packument, which has the time the lookup lacks.
    expect(server.requests.map((r) => [r.url, r.headers.accept])).toEqual([
      ['/@types%2fms', ABBREVIATED_ACCEPT],
      ['/@types%2fms', 'application/json'],
    ])
    expect(times[0]['2.1.0']).toBe(FULL_2_1_0)
    expect(times[1]).toEqual(times[0])
    expect(times[2]).toEqual(times[0])
  })

  it('shares one client between concurrent first requests for different packages', async () => {
    const server = await start(typesMs)
    const session = sessionFor(configFor(server.url))

    await Promise.all([
      session.releaseTimes('a'),
      session.releaseTimes('b'),
      session.releaseTimes('c'),
    ])

    expect(server.requests).toHaveLength(6)
    expect(server.connections).toBeLessThanOrEqual(3)
  })

  it('answers {} once, and asks nothing more, when the lookup fails', async () => {
    const server = await start(status(500))
    const session = sessionFor(configFor(server.url, { fetchRetries: 0 }))

    expect(await session.releaseTimes('ms')).toEqual({})
    expect(await session.releaseTimes('ms')).toEqual({})
    expect(server.requests).toHaveLength(1)
  })

  it('answers {} once when the full packument fails, without rejecting', async () => {
    const server = await start((req, res) =>
      req.headers.accept === ABBREVIATED_ACCEPT
        ? typesMs(req, res)
        : status(500)(req, res),
    )
    const session = sessionFor(configFor(server.url))

    expect(await session.releaseTimes('@types/ms')).toEqual({})
    expect(await session.releaseTimes('@types/ms')).toEqual({})
    expect(server.requests).toHaveLength(2)
  })

  it('fails open when the registry is unreachable', async () => {
    const server = await start(typesMs)
    const session = sessionFor(configFor(server.url))
    await server.close()

    expect(await session.releaseTimes('@types/ms')).toEqual({})
  })

  it.each([
    [
      'no time',
      (body: Record<string, unknown>) => {
        delete body.time
      },
    ],
    [
      'a time that is not an object',
      (body: Record<string, unknown>) => {
        body.time = 'soon'
      },
    ],
    [
      'a document that is not a packument',
      (body: Record<string, unknown>) => {
        delete body.versions
      },
    ],
  ])('answers {} for a full packument with %s', async (_label, edit) => {
    const server = await start((req, res) =>
      req.headers.accept === ABBREVIATED_ACCEPT
        ? typesMs(req, res)
        : res.end(derive('types-ms.packument-full', edit)),
    )

    expect(
      await sessionFor(configFor(server.url)).releaseTimes('@types/ms'),
    ).toEqual({})
  })

  it('asks the scope registry for a scoped package, with its own credentials (#104)', async () => {
    const corp = await start(typesMs)
    const standard = await start(typesMs)
    const session = sessionFor(
      configFor(standard.url, {
        scopedRegistries: { '@types': corp.url },
        credentials: {
          [`//127.0.0.1:${corp.port}/`]: { authToken: 'SCOPED' },
          [`//127.0.0.1:${standard.port}/`]: { authToken: 'DEFAULT' },
        },
      }),
    )

    expect((await session.releaseTimes('@types/ms'))['2.1.0']).toBe(FULL_2_1_0)
    expect(corp.requests.map((r) => [r.url, r.headers.authorization])).toEqual([
      ['/@types%2fms', 'Bearer SCOPED'],
      ['/@types%2fms', 'Bearer SCOPED'],
    ])
    expect(standard.requests).toEqual([])

    await session.releaseTimes('ms')
    expect(
      standard.requests.map((r) => [r.url, r.headers.authorization]),
    ).toEqual([
      ['/ms', 'Bearer DEFAULT'],
      ['/ms', 'Bearer DEFAULT'],
    ])
    expect(corp.requests).toHaveLength(2)
  })

  it('asks again in a new session', async () => {
    const server = await start(typesMs)
    const config = configFor(server.url)

    await sessionFor(config).releaseTimes('@types/ms')
    await sessionFor(config).releaseTimes('@types/ms')

    expect(server.requests).toHaveLength(4)
  })

  it('reads no config until a request, then once for the whole run', async () => {
    const server = await start(typesMs)
    const loadConfig = jest.fn(() => configFor(server.url))
    const session = createRegistrySession('/project', { loadConfig })
    sessions.push(session)

    expect(loadConfig).not.toHaveBeenCalled()

    await session.releaseTimes('a')
    await session.releaseTimes('b')
    await session.client()

    expect(loadConfig).toHaveBeenCalledTimes(1)
    expect(loadConfig).toHaveBeenCalledWith('/project')
  })

  it('hands every caller the same client and the same config', async () => {
    const server = await start(typesMs)
    const session = sessionFor(configFor(server.url))

    const [first, second] = await Promise.all([
      session.client(),
      session.client(),
    ])

    expect(first).toBe(second)
    expect(session.registryConfig()).toBe(session.registryConfig())
  })

  it('reuses one connection for sequential packages', async () => {
    const server = await start(typesMs)
    const session = sessionFor(configFor(server.url))

    await session.releaseTimes('a')
    await session.releaseTimes('b')

    // A lookup and a full packument for each.
    expect(server.requests).toHaveLength(4)
    expect(server.connections).toBe(1)
  })

  it('closes safely before any request, and twice after one', async () => {
    const server = await start(typesMs)
    const session = sessionFor(configFor(server.url))

    expect(() => session.close()).not.toThrow()

    await session.releaseTimes('a')
    session.close()
    expect(() => session.close()).not.toThrow()
  })

  it('destroys a client that was still loading when close() ran', async () => {
    const server = await start(typesMs)
    const created: RegistryClient[] = []
    let fresh: typeof import('@/utils/registry') | undefined
    await jest.isolateModulesAsync(async () => {
      jest.doMock('@/utils/registryClient', () => {
        const actual = jest.requireActual<
          typeof import('@/utils/registryClient')
        >('@/utils/registryClient')
        return {
          ...actual,
          createRegistryClient: (
            ...args: Parameters<typeof actual.createRegistryClient>
          ) => {
            const client = actual.createRegistryClient(...args)
            jest.spyOn(client, 'destroy')
            created.push(client)
            return client
          },
        }
      })
      fresh = await import('@/utils/registry')
    })
    const session = fresh?.createRegistrySession('/project', {
      loadConfig: () => configFor(server.url),
    })

    const pending = session?.client()
    session?.close()
    await pending

    expect(created).toHaveLength(1)
    expect(created[0]?.destroy).toHaveBeenCalledTimes(1)
  })

  describe('lookup', () => {
    const msServer = () =>
      start(
        replies({
          '/-/package/ms/dist-tags': { body: registryBody('ms.dist-tags') },
          '/ms': { body: registryBody('ms.packument') },
        }),
      )

    it('looks a package up once per session', async () => {
      const server = await msServer()
      const session = createRegistrySession('/project', {
        loadConfig: () => configFor(server.url),
        depsDev: false,
      })
      sessions.push(session)

      const [first, second] = await Promise.all([
        session.lookup('ms'),
        session.lookup('ms'),
      ])
      await session.lookup('ms')

      expect(first).toBe(second)
      expect(first).toMatchObject({ ok: true, package: { latest: '2.1.3' } })
      expect(server.requests.map((r) => r.url)).toEqual(['/ms'])
    })

    it('answers lookedUp only with what the session already looked up, asking nothing (#195)', async () => {
      const server = await msServer()
      const session = createRegistrySession('/project', {
        loadConfig: () => configFor(server.url),
        depsDev: false,
      })
      sessions.push(session)

      expect(session.lookedUp('ms')).toBeUndefined()
      const looked = await session.lookup('ms')

      expect(await session.lookedUp('ms')).toBe(looked)
      expect(session.lookedUp('mkdirp')).toBeUndefined()
      expect(server.requests.map((r) => r.url)).toEqual(['/ms'])
    })

    it('shares the client and the config load with releaseTimes', async () => {
      const server = await msServer()
      const loadConfig = jest.fn(() => configFor(server.url))
      const session = createRegistrySession('/project', {
        loadConfig,
        depsDev: false,
      })
      sessions.push(session)

      await session.lookup('ms')
      await session.releaseTimes('ms')

      expect(loadConfig).toHaveBeenCalledTimes(1)
      expect(server.requests).toHaveLength(2)
      expect(server.connections).toBe(1)
      expect(Object.keys((await session.client()).stats())).toHaveLength(1)
    })

    it('passes depsDev to the reader: false sends nothing to deps.dev', async () => {
      const registry = await msServer()
      const depsDev = await start(
        replies({
          '/v3/systems/npm/packages/ms': { body: registryBody('ms.deps-dev') },
        }),
      )
      const endpoints = {
        publicRegistries: [new URL(registry.url).origin],
        depsDev: `${depsDev.url}v3/systems/npm/packages/`,
      }
      const open = (flag: boolean) => {
        const session = createRegistrySession('/project', {
          loadConfig: () => configFor(registry.url),
          depsDev: flag,
          endpoints,
        })
        sessions.push(session)
        return session
      }

      expect(await open(false).lookup('ms')).toMatchObject({
        ok: true,
        package: { source: 'packument' },
      })
      expect(depsDev.requests).toEqual([])

      expect(await open(true).lookup('ms')).toMatchObject({
        ok: true,
        package: { source: 'deps.dev' },
      })
      expect(depsDev.requests).toHaveLength(1)
    })

    it("answers releaseTimes from the lookup's deps.dev dates, asking no packument (#139)", async () => {
      // The registry serves no packument at all, as a mirror that lags or a
      // proxy hiding fresh versions might; deps.dev and the dist-tags show 2.1.3.
      const registry = await start(
        replies({
          '/-/package/ms/dist-tags': { body: registryBody('ms.dist-tags') },
        }),
      )
      const depsDev = await start(
        replies({
          '/v3/systems/npm/packages/ms': { body: registryBody('ms.deps-dev') },
        }),
      )
      const session = createRegistrySession('/project', {
        loadConfig: () => configFor(registry.url),
        endpoints: {
          publicRegistries: [new URL(registry.url).origin],
          depsDev: `${depsDev.url}v3/systems/npm/packages/`,
        },
      })
      sessions.push(session)

      await session.lookup('ms')
      const times = await session.releaseTimes('ms', {
        current: '2.1.2',
        target: '2.1.3',
      })
      const everything = await session.releaseTimes('ms')

      expect(times['2.1.3']).toBe('2020-12-08T13:54:35Z')
      expect(times['2.1.2']).toBe('2019-06-06T17:31:55Z')
      expect(everything).toEqual(times)
      expect(registry.requests.map((r) => r.url)).toEqual([
        '/-/package/ms/dist-tags',
      ])
    })

    it('asks deps.dev by default', async () => {
      const registry = await msServer()
      const depsDev = await start(
        replies({
          '/v3/systems/npm/packages/ms': { body: registryBody('ms.deps-dev') },
        }),
      )
      const session = createRegistrySession('/project', {
        loadConfig: () => configFor(registry.url),
        endpoints: {
          publicRegistries: [new URL(registry.url).origin],
          depsDev: `${depsDev.url}v3/systems/npm/packages/`,
        },
      })
      sessions.push(session)

      await session.lookup('ms')

      expect(depsDev.requests).toHaveLength(1)
    })
  })

  describe('versionManifest (#196)', () => {
    const msWithManifest: Handler = (req, res) =>
      replies({
        '/ms': { body: registryBody('ms.packument') },
        '/ms/2.1.3': { body: registryBody('ms.2.1.3.manifest') },
      })(req, res)

    it('loads and reads nothing before the call, then reads through the reader', async () => {
      const server = await start(msWithManifest)
      const loadConfig = jest.fn(() => configFor(server.url))
      const session = createRegistrySession('/project', {
        loadConfig,
        depsDev: false,
      })
      sessions.push(session)
      expect(loadConfig).not.toHaveBeenCalled()

      expect(await session.versionManifest('ms', '2.1.3')).toMatchObject({
        name: 'ms',
        version: '2.1.3',
        license: 'MIT',
      })
      expect(server.requests.map((r) => r.url)).toEqual(['/ms', '/ms/2.1.3'])
    })

    it('sends nothing for a package routed through a registry the manager cannot use', async () => {
      const server = await start(msWithManifest)
      const session = sessionFor(
        configFor(server.url, {
          unusable: {
            scopes: {
              '@acme': {
                key: '@acme:registry',
                value: 'ftp://x/',
                source: '.npmrc',
                reason: 'not http(s)',
              },
            },
          },
        }),
      )

      expect(await session.versionManifest('@acme/ui', '1.0.0')).toBeUndefined()
      expect(server.requests).toEqual([])
      expect(
        jest
          .mocked(logger.debug)
          .mock.calls.some(([line]) =>
            String(line).startsWith('Not asking for @acme/ui@1.0.0: '),
          ),
      ).toBe(true)
    })

    it('resolves undefined when the reader throws', async () => {
      const session = createRegistrySession('/project', {
        loadConfig: () => {
          throw new Error('broken view')
        },
      })
      sessions.push(session)

      await expect(
        session.versionManifest('ms', '2.1.3'),
      ).resolves.toBeUndefined()
    })

    it('still warns at close when the manifest request was throttled', async () => {
      const server = await start((req, res) => {
        if (req.url === '/ms/2.1.3') {
          res.statusCode = 429
          res.setHeader('retry-after', '30')
          res.end('slow down')
          return
        }
        msWithManifest(req, res)
      })
      const session = createRegistrySession('/project', {
        loadConfig: () => configFor(server.url),
        depsDev: false,
      })
      sessions.push(session)

      expect(await session.versionManifest('ms', '2.1.3')).toBeUndefined()
      session.close()

      expect(logger.warn).toHaveBeenCalledTimes(1)
      expect(jest.mocked(logger.warn).mock.calls[0][0]).toContain(
        `127.0.0.1:${server.port} (1 request)`,
      )
    })
  })

  describe('a throttled run (#174)', () => {
    const throttled: Handler = (_req, res) => {
      res.statusCode = 429
      res.setHeader('retry-after', '30')
      res.end('slow down')
    }
    const depsDevMs = replies({
      '/v3/systems/npm/packages/ms': { body: registryBody('ms.deps-dev') },
    })
    const open = (registry: TestRegistry, depsDev: TestRegistry) => {
      const session = createRegistrySession('/project', {
        loadConfig: () => configFor(registry.url),
        endpoints: {
          publicRegistries: [new URL(registry.url).origin],
          depsDev: `${depsDev.url}v3/systems/npm/packages/`,
        },
      })
      sessions.push(session)
      return session
    }

    it('warns once, naming the host, when dist-tags answers 429 and the lookup falls back to the packument', async () => {
      const packument = replies({
        '/ms': { body: registryBody('ms.packument') },
      })
      const registry = await start((req, res) =>
        req.url === '/-/package/ms/dist-tags'
          ? throttled(req, res)
          : packument(req, res),
      )
      const depsDev = await start(depsDevMs)
      const session = open(registry, depsDev)

      expect(await session.lookup('ms')).toMatchObject({
        ok: true,
        package: { latest: '2.1.3', source: 'packument' },
      })
      expect(logger.warn).not.toHaveBeenCalled()

      session.close()
      session.close()

      expect(logger.warn).toHaveBeenCalledTimes(1)
      const [text] = jest.mocked(logger.warn).mock.calls[0]
      expect(text).toContain(`127.0.0.1:${registry.port} (1 request)`)
    })

    it('warns nothing when no host throttled the run', async () => {
      const registry = await start(
        replies({
          '/-/package/ms/dist-tags': { body: registryBody('ms.dist-tags') },
        }),
      )
      const depsDev = await start(depsDevMs)
      const session = open(registry, depsDev)

      expect(await session.lookup('ms')).toMatchObject({
        ok: true,
        package: { source: 'deps.dev' },
      })
      session.close()

      expect(logger.warn).not.toHaveBeenCalled()
    })

    it('names deps.dev when deps.dev is the host that throttled', async () => {
      const registry = await start(
        replies({
          '/-/package/ms/dist-tags': { body: registryBody('ms.dist-tags') },
          '/ms': { body: registryBody('ms.packument') },
        }),
      )
      const depsDev = await start(throttled)
      const session = open(registry, depsDev)

      expect(await session.lookup('ms')).toMatchObject({
        ok: true,
        package: { latest: '2.1.3', source: 'packument' },
      })
      session.close()

      expect(logger.warn).toHaveBeenCalledTimes(1)
      const [text] = jest.mocked(logger.warn).mock.calls[0]
      expect(text).toContain(`127.0.0.1:${depsDev.port} (1 request)`)
      expect(text).not.toContain(`127.0.0.1:${registry.port}`)
    })

    it('counts every 429 across packages', async () => {
      const packuments = replies({
        '/ms': { body: registryBody('ms.packument') },
        '/ms-two': { body: registryBody('ms.packument') },
      })
      const registry = await start((req, res) =>
        req.url?.includes('/dist-tags')
          ? throttled(req, res)
          : packuments(req, res),
      )
      const depsDev = await start((_req, res) => {
        res.setHeader('content-type', 'application/json')
        res.end(registryBody('ms.deps-dev'))
      })
      const session = open(registry, depsDev)

      await Promise.all([session.lookup('ms'), session.lookup('ms-two')])
      session.close()

      expect(logger.warn).toHaveBeenCalledTimes(1)
      const [text] = jest.mocked(logger.warn).mock.calls[0]
      expect(text).toContain(`127.0.0.1:${registry.port} (2 requests)`)
    })
  })

  describe('behind a manager release-age gate (#168)', () => {
    // pnpm's: a day, and a version with no known time is let through.
    const gate: ReleaseAgeGate = {
      setting: 'minimumReleaseAge',
      minutes: 1440,
      scopes: {},
      exempt: [],
      missingTime: 'allowed',
    }
    // Inside the gate of @types/ms's `modified` (2026-10-04T08:50:16.855Z), so
    // the shortcut of #177 does not apply and the full packument is read.
    const NOW = Date.parse('2026-10-04T09:00:00Z')
    // Three days past that `modified`: every version clears the gate.
    const LATER = Date.parse('2026-10-07T09:00:00Z')

    it('reads the full packument once for a lookup deps.dev lags on, and never again for the lookup or the cooldown', async () => {
      const registry = await start((req, res) =>
        req.url === '/-/package/@types%2fms/dist-tags'
          ? res.end(registryBody('types-ms.dist-tags'))
          : typesMs(req, res),
      )
      const depsDev = await start(
        replies({
          '/v3/systems/npm/packages/%40types%2Fms': {
            body: derive<{
              versions: Array<{ versionKey: { version: string } }>
            }>('types-ms.deps-dev', (body) => {
              body.versions = body.versions.filter(
                (v) => v.versionKey.version !== '2.1.0',
              )
            }),
          },
        }),
      )
      const session = createRegistrySession('/project', {
        loadConfig: () => configFor(registry.url),
        endpoints: {
          publicRegistries: [new URL(registry.url).origin],
          depsDev: `${depsDev.url}v3/systems/npm/packages/`,
        },
      })
      sessions.push(session)
      const gated = withReleaseAgeGate(
        session,
        () => gate,
        () => NOW,
      )
      const packumentAccepts = () =>
        registry.requests
          .filter((r) => r.url === '/@types%2fms')
          .map((r) => r.headers.accept)

      const first = await gated.lookup('@types/ms')
      expect(first).toMatchObject({ ok: true, package: { latest: '2.1.0' } })
      expect(packumentAccepts()).toEqual([
        ABBREVIATED_ACCEPT,
        'application/json',
      ])
      const before = registry.requests.length

      const again = await gated.lookup('@types/ms')
      const times = await gated.releaseTimes('@types/ms', {
        current: '0.7.34',
        target: '2.1.0',
      })

      expect(again).toEqual(first)
      expect(times['2.1.0']).toBe(FULL_2_1_0)
      expect(registry.requests).toHaveLength(before)
    })

    describe('the packument modified (#177)', () => {
      const gatedSession = async (
        handler: Handler,
        options: {
          public?: boolean
          now?: number
          cache?: { dir: string; now: () => number }
        } = {},
      ) => {
        const registry = await start(handler)
        const session = createRegistrySession('/project', {
          loadConfig: () => configFor(registry.url),
          depsDev: false,
          endpoints: {
            publicRegistries:
              options.public === false ? [] : [new URL(registry.url).origin],
            depsDev: 'http://127.0.0.1:1/',
          },
          cache: options.cache,
        })
        sessions.push(session)
        const gated = withReleaseAgeGate(
          session,
          () => gate,
          () => options.now ?? LATER,
        )
        const accepts = () =>
          registry.requests
            .filter((r) => r.url === '/@types%2fms')
            .map((r) => r.headers.accept)
        return { registry, gated, accepts }
      }
      const versionsOf = (lookup: PackageLookup) =>
        lookup.ok ? lookup.package.versions.map((v) => v.version) : []

      it('asks only the abbreviated packument for a package modified before the gate', async () => {
        const { gated, accepts } = await gatedSession(typesMs)

        const result = await gated.lookup('@types/ms')

        expect(result).toMatchObject({ ok: true, package: { latest: '2.1.0' } })
        expect(accepts()).toEqual([ABBREVIATED_ACCEPT])
      })

      it('reads the full packument when it was modified inside the gate', async () => {
        const { gated, accepts } = await gatedSession(typesMs, { now: NOW })

        await gated.lookup('@types/ms')

        expect(accepts()).toEqual([ABBREVIATED_ACCEPT, 'application/json'])
      })

      it('trusts nothing from a registry that is not public npm, and gates to the same versions', async () => {
        const trusted = await gatedSession(typesMs)
        const other = await gatedSession(typesMs, { public: false })

        const fromTrusted = await trusted.gated.lookup('@types/ms')
        const fromOther = await other.gated.lookup('@types/ms')

        expect(other.accepts()).toEqual([
          ABBREVIATED_ACCEPT,
          'application/json',
        ])
        expect(trusted.accepts()).toEqual([ABBREVIATED_ACCEPT])
        expect(versionsOf(fromOther)).toEqual(versionsOf(fromTrusted))
        expect(fromOther.ok && fromOther.package.latest).toBe(
          fromTrusted.ok && fromTrusted.package.latest,
        )
      })

      it('still reads the full packument once for a cooldown window after the shortcut', async () => {
        const { gated, accepts } = await gatedSession(typesMs)

        await gated.lookup('@types/ms')
        const times = await gated.releaseTimes('@types/ms', {
          current: '0.7.34',
          target: '2.1.0',
        })
        await gated.releaseTimes('@types/ms', {
          current: '0.7.34',
          target: '2.1.0',
        })

        expect(times['2.1.0']).toBe(FULL_2_1_0)
        expect(accepts()).toEqual([ABBREVIATED_ACCEPT, 'application/json'])
      })

      it('reads the full packument when a 304 revalidates an entry stored without modified', async () => {
        const dir = path.join(
          fs.realpathSync(
            fs.mkdtempSync(path.join(os.tmpdir(), 'autd-session-')),
          ),
          'cache',
        )
        try {
          const registry = await start(
            conditional(
              { body: registryBody('types-ms.packument') },
              '"abbreviated"',
            ),
          )
          const stored = parsePackument(
            JSON.parse(registryBody('types-ms.packument')),
          ) as ParsedPackument
          const { modified: _dropped, ...older } = stored
          const writer = createRegistryCache({ dir, now: () => 0 })
          writer.put('packument', registry.url, '@types/ms', older, {
            authenticated: false,
            etag: '"abbreviated"',
          })
          writer.close()
          const session = createRegistrySession('/project', {
            loadConfig: () => configFor(registry.url),
            depsDev: false,
            endpoints: {
              publicRegistries: [new URL(registry.url).origin],
              depsDev: 'http://127.0.0.1:1/',
            },
            cache: { dir, now: () => 3_600_000 },
          })
          sessions.push(session)
          // The server answers the full document for any other Accept.
          registry.requests.length = 0

          const gated = withReleaseAgeGate(
            session,
            () => gate,
            () => LATER,
          )
          const result = await gated.lookup('@types/ms')

          expect(result.ok).toBe(true)
          expect(
            registry.requests.map((r) => [
              r.headers.accept,
              r.headers['if-none-match'],
            ]),
          ).toEqual([
            [ABBREVIATED_ACCEPT, '"abbreviated"'],
            ['application/json', undefined],
          ])
        } finally {
          fs.rmSync(path.dirname(dir), { recursive: true, force: true })
        }
      })
    })
  })

  describe('the disk cache', () => {
    let dir: string
    beforeEach(() => {
      dir = path.join(
        fs.realpathSync(
          fs.mkdtempSync(path.join(os.tmpdir(), 'autd-session-')),
        ),
        'cache',
      )
    })
    afterEach(() => {
      fs.rmSync(path.dirname(dir), { recursive: true, force: true })
    })

    const msServer = () =>
      start(
        replies({
          '/-/package/ms/dist-tags': { body: registryBody('ms.dist-tags') },
          '/ms': { body: registryBody('ms.packument') },
        }),
      )
    const sessionWith = (
      server: TestRegistry,
      cache?: { dir?: string; maxBytes?: number },
    ) => {
      const session = createRegistrySession('/project', {
        loadConfig: () => configFor(server.url),
        depsDev: false,
        cache,
      })
      sessions.push(session)
      return session
    }
    const debugLines = () =>
      jest
        .mocked(logger.debug)
        .mock.calls.map(([line]) => String(line))
        .filter((line) => line.startsWith('registry cache'))

    it('writes nothing without the option, and logs nothing at close', async () => {
      const server = await msServer()
      const session = sessionWith(server)

      await session.lookup('ms')
      session.close()

      expect(fs.existsSync(dir)).toBe(false)
      expect(debugLines()).toEqual([])
    })

    it('reads and creates nothing until the first lookup, and none for a close before it', async () => {
      const server = await msServer()
      const session = sessionWith(server, { dir })

      session.close()

      expect(fs.existsSync(dir)).toBe(false)
      expect(debugLines()).toEqual([])
      expect(server.requests).toEqual([])
    })

    it('writes nothing when close() ran while the reader was still loading', async () => {
      const server = await msServer()
      const session = sessionWith(server, { dir })

      const pending = session.lookup('ms')
      session.close()
      await pending

      expect(fs.existsSync(dir)).toBe(false)
      expect(debugLines()).toEqual([])
    })

    it('hands its folder to the reader: a second session asks nobody', async () => {
      const server = await msServer()
      const first = sessionWith(server, { dir })
      await first.lookup('ms')
      first.close()
      server.requests.splice(0)

      const second = sessionWith(server, { dir })
      const result = await second.lookup('ms')

      expect(result).toMatchObject({ ok: true, package: { latest: '2.1.3' } })
      expect(server.requests).toEqual([])
    })

    it('prunes at close once, logs one line, and is safe twice', async () => {
      const server = await msServer()
      const session = sessionWith(server, { dir, maxBytes: 1 })
      await session.lookup('ms')
      expect(fs.readdirSync(path.join(dir, 'v1', 'packument'))).toHaveLength(1)

      session.close()
      session.close()

      expect(fs.readdirSync(path.join(dir, 'v1', 'packument'))).toEqual([])
      const lines = debugLines()
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatch(
        /1 written, 1 pruned; requests: 127\.0\.0\.1:\d+ 1/,
      )
    })

    it('says "none" when the run asked nobody', async () => {
      const server = await msServer()
      const first = sessionWith(server, { dir })
      await first.lookup('ms')
      first.close()
      jest.mocked(logger.debug).mockClear()

      const second = sessionWith(server, { dir })
      await second.lookup('ms')
      second.close()

      expect(debugLines()).toEqual([
        expect.stringMatching(
          /1 fresh, 0 covered, 0 revalidated, 0 fetched, 0 written, 0 pruned; requests: none$/,
        ),
      ])
    })

    it('counts a stale full packument that the coverage rule answers (#176)', async () => {
      let clock = Date.parse('2026-11-05T00:00:00Z')
      const server = await start(typesMs)
      const open = () => {
        const session = createRegistrySession('/project', {
          loadConfig: () => configFor(server.url),
          depsDev: false,
          cache: { dir, now: () => clock },
        })
        sessions.push(session)
        return session
      }
      const first = open()
      await first.releaseTimes('@types/ms')
      first.close()
      jest.mocked(logger.debug).mockClear()

      clock += 301 * 1000
      const second = open()
      await second.releaseTimes('@types/ms')
      second.close()

      // The abbreviated packument is past its TTL and has no ETag, so it is
      // fetched again; the full one still lists every version it needs.
      expect(debugLines()).toEqual([
        expect.stringMatching(
          /0 fresh, 1 covered, 0 revalidated, 1 fetched, 1 written, 0 pruned; requests: 127\.0\.0\.1:\d+ 1$/,
        ),
      ])
    })
  })

  describe('routes read from the manager own files', () => {
    let tmp: string
    beforeEach(() => {
      tmp = fs.realpathSync(
        fs.mkdtempSync(path.join(os.tmpdir(), 'autd-route-')),
      )
    })
    afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

    const sources = (): NpmrcSources => ({
      env: {},
      home: path.join(tmp, 'home'),
      execPath: process.execPath,
      platform: process.platform,
    })

    // The scope's registry answers the abbreviated packument and the full one.
    const scopeServer = () => start(typesMs)

    const sessionWith = (
      adapter: Pick<ManagerAdapter, 'npmrcLayers' | 'registryConfig'>,
    ): RegistrySession => {
      const session = createRegistrySession(tmp, {
        depsDev: false,
        loadConfig: (dir) => {
          return managerRegistryConfig(adapter, dir, sources())
        },
      })
      sessions.push(session)
      return session
    }

    it('sends a scope routed only by bunfig.toml to its server with the bunfig token, for lookup and releaseTimes', async () => {
      const decoy = await start(replies({}))
      const server = await scopeServer()
      fs.writeFileSync(
        path.join(tmp, 'bunfig.toml'),
        `[install]\nregistry = "${decoy.url}"\n[install.scopes]\n"@types" = { url = "${server.url}", token = "T-bunfig" }\n`,
      )
      fs.writeFileSync(
        path.join(tmp, '.npmrc'),
        `//127.0.0.1:${server.port}/:_authToken=T-npmrc\n`,
      )
      const session = sessionWith(bun)

      const found = await session.lookup('@types/ms')
      const times = await session.releaseTimes('@types/ms')

      expect(found).toMatchObject({ ok: true, package: { latest: '2.1.0' } })
      expect(Object.keys(times).length).toBeGreaterThan(0)
      expect(server.requests.map((r) => r.url)).toEqual([
        '/@types%2fms',
        '/@types%2fms',
      ])
      expect(server.requests.map((r) => r.headers.authorization)).toEqual([
        'Bearer T-bunfig',
        'Bearer T-bunfig',
      ])
      expect(decoy.requests).toEqual([])
    })

    it('sends a scope routed only by pnpm-workspace.yaml to its server with the .npmrc token, for lookup and releaseTimes', async () => {
      const server = await scopeServer()
      fs.writeFileSync(
        path.join(tmp, 'pnpm-workspace.yaml'),
        `registries:\n  "@types": ${server.url}\n`,
      )
      fs.writeFileSync(
        path.join(tmp, '.npmrc'),
        `//127.0.0.1:${server.port}/:_authToken=T-npmrc\n`,
      )
      const session = sessionWith(pnpm)

      const found = await session.lookup('@types/ms')
      const times = await session.releaseTimes('@types/ms')

      expect(found).toMatchObject({ ok: true, package: { latest: '2.1.0' } })
      expect(Object.keys(times).length).toBeGreaterThan(0)
      expect(server.requests.map((r) => r.headers.authorization)).toEqual([
        'Bearer T-npmrc',
        'Bearer T-npmrc',
      ])
    })
  })
})
