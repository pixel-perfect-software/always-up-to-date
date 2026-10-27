jest.mock('@/utils/logger')

import fs from 'fs'
import type http from 'http'
import os from 'os'
import path from 'path'
import type { ManagerAdapter } from '@/managers/adapter'
import bun from '@/managers/bun'
import pnpm from '@/managers/pnpm'
import type { RegistryConfig } from '@/types'
import logger from '@/utils/logger'
import { managerRegistryConfig, type NpmrcSources } from '@/utils/npmrcLoader'
import { createRegistrySession, type RegistrySession } from '@/utils/registry'
import type { RegistryClient } from '@/utils/registryClient'
import {
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

const packument =
  (body: unknown) => (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
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

  it('fetches a package once while several manifests ask for it at the same time', async () => {
    const server = await start(
      packument({ time: { '1.0.0': '2026-01-01T00:00:00.000Z' } }),
    )
    const session = sessionFor(configFor(server.url))

    const times = await Promise.all([
      session.releaseTimes('dayjs'),
      session.releaseTimes('dayjs'),
      session.releaseTimes('dayjs'),
    ])

    expect(server.requests.map((r) => r.url)).toEqual(['/dayjs'])
    expect(times).toEqual([
      { '1.0.0': '2026-01-01T00:00:00.000Z' },
      { '1.0.0': '2026-01-01T00:00:00.000Z' },
      { '1.0.0': '2026-01-01T00:00:00.000Z' },
    ])
  })

  it('shares one client between concurrent first requests for different packages', async () => {
    const server = await start(packument({ time: {} }))
    const session = sessionFor(configFor(server.url))

    await Promise.all([
      session.releaseTimes('a'),
      session.releaseTimes('b'),
      session.releaseTimes('c'),
    ])

    expect(server.requests).toHaveLength(3)
    expect(server.connections).toBeLessThanOrEqual(3)
  })

  it('fails open to an empty map, once, on a network error', async () => {
    const server = await start((_req, res) => {
      res.statusCode = 500
      res.end()
    })
    const session = sessionFor(configFor(server.url, { fetchRetries: 0 }))

    expect(await session.releaseTimes('ms')).toEqual({})
    expect(await session.releaseTimes('ms')).toEqual({})
    expect(server.requests).toHaveLength(1)
  })

  it('fails open when the registry is unreachable', async () => {
    const server = await start(packument({}))
    const session = sessionFor(configFor(server.url))
    await server.close()

    expect(await session.releaseTimes('ms')).toEqual({})
  })

  it('keeps only the string entries of time', async () => {
    const server = await start(
      packument({
        time: {
          '1.0.0': '2026-01-01T00:00:00.000Z',
          '2.0.0': 7,
          '3.0.0': null,
        },
      }),
    )

    expect(await sessionFor(configFor(server.url)).releaseTimes('ms')).toEqual({
      '1.0.0': '2026-01-01T00:00:00.000Z',
    })
  })

  it.each([
    ['no time', {}],
    ['a time that is not an object', { time: 'soon' }],
    ['a document that is not an object', ['x']],
  ])('returns an empty map for %s', async (_label, body) => {
    const server = await start(packument(body))

    expect(await sessionFor(configFor(server.url)).releaseTimes('ms')).toEqual(
      {},
    )
  })

  it('asks the scope registry for a scoped package, with its own credentials (#104)', async () => {
    const corp = await start(
      packument({ time: { '1.0.0': '2026-02-01T00:00:00.000Z' } }),
    )
    const standard = await start(
      packument({ time: { '9.9.9': '2026-03-01T00:00:00.000Z' } }),
    )
    const session = sessionFor(
      configFor(standard.url, {
        scopedRegistries: { '@corp': corp.url },
        credentials: {
          [`//127.0.0.1:${corp.port}/`]: { authToken: 'SCOPED' },
          [`//127.0.0.1:${standard.port}/`]: { authToken: 'DEFAULT' },
        },
      }),
    )

    expect(await session.releaseTimes('@corp/pkg')).toEqual({
      '1.0.0': '2026-02-01T00:00:00.000Z',
    })
    expect(corp.requests.map((r) => [r.url, r.headers.authorization])).toEqual([
      ['/@corp%2fpkg', 'Bearer SCOPED'],
    ])
    expect(standard.requests).toEqual([])

    await session.releaseTimes('ms')
    expect(
      standard.requests.map((r) => [r.url, r.headers.authorization]),
    ).toEqual([['/ms', 'Bearer DEFAULT']])
    expect(corp.requests).toHaveLength(1)
  })

  it('asks again in a new session', async () => {
    const server = await start(packument({ time: {} }))
    const config = configFor(server.url)

    await sessionFor(config).releaseTimes('ms')
    await sessionFor(config).releaseTimes('ms')

    expect(server.requests).toHaveLength(2)
  })

  it('reads no config until a request, then once for the whole run', async () => {
    const server = await start(packument({ time: {} }))
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
    const server = await start(packument({ time: {} }))
    const session = sessionFor(configFor(server.url))

    const [first, second] = await Promise.all([
      session.client(),
      session.client(),
    ])

    expect(first).toBe(second)
    expect(session.registryConfig()).toBe(session.registryConfig())
  })

  it('reuses one connection for sequential packages', async () => {
    const server = await start(packument({ time: {} }))
    const session = sessionFor(configFor(server.url))

    await session.releaseTimes('a')
    await session.releaseTimes('b')

    expect(server.requests).toHaveLength(2)
    expect(server.connections).toBe(1)
  })

  it('closes safely before any request, and twice after one', async () => {
    const server = await start(packument({ time: {} }))
    const session = sessionFor(configFor(server.url))

    expect(() => session.close()).not.toThrow()

    await session.releaseTimes('a')
    session.close()
    expect(() => session.close()).not.toThrow()
  })

  it('destroys a client that was still loading when close() ran', async () => {
    const server = await start(packument({ time: {} }))
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
          /1 fresh, 0 revalidated, 0 fetched, 0 written, 0 pruned; requests: none$/,
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
    const scopeServer = () =>
      start((req, res) => {
        res.setHeader('content-type', 'application/json')
        const full = !String(req.headers.accept).includes('install-v1')
        res.end(
          registryBody(full ? 'types-ms.packument-full' : 'types-ms.packument'),
        )
      })

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
