jest.mock('@/utils/logger')

import type http from 'http'
import type { RegistryConfig } from '@/types'
import { clearRegistryCache, fetchReleaseTimes } from '@/utils/registry'
import { startRegistry, type TestRegistry } from '../fixtures/registry'

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

describe('fetchReleaseTimes', () => {
  const servers: TestRegistry[] = []
  const start = async (handler: Parameters<typeof startRegistry>[0]) => {
    const server = await startRegistry(handler)
    servers.push(server)
    return server
  }

  afterEach(async () => {
    clearRegistryCache()
    await Promise.all(servers.splice(0).map((s) => s.close()))
  })

  it('fetches a package once while several manifests ask for it at the same time', async () => {
    const server = await start(
      packument({ time: { '1.0.0': '2026-01-01T00:00:00.000Z' } }),
    )
    const config = configFor(server.url)

    const times = await Promise.all([
      fetchReleaseTimes('dayjs', config),
      fetchReleaseTimes('dayjs', config),
      fetchReleaseTimes('dayjs', config),
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
    const config = configFor(server.url)

    await Promise.all([
      fetchReleaseTimes('a', config),
      fetchReleaseTimes('b', config),
      fetchReleaseTimes('c', config),
    ])

    expect(server.requests).toHaveLength(3)
    expect(server.connections).toBeLessThanOrEqual(3)
  })

  it('fails open to an empty map, once, on a network error', async () => {
    const server = await start((_req, res) => {
      res.statusCode = 500
      res.end()
    })
    const config = configFor(server.url, { fetchRetries: 0 })

    expect(await fetchReleaseTimes('ms', config)).toEqual({})
    expect(await fetchReleaseTimes('ms', config)).toEqual({})
    expect(server.requests).toHaveLength(1)
  })

  it('fails open when the registry is unreachable', async () => {
    const server = await start(packument({}))
    const config = configFor(server.url)
    await server.close()

    expect(await fetchReleaseTimes('ms', config)).toEqual({})
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

    expect(await fetchReleaseTimes('ms', configFor(server.url))).toEqual({
      '1.0.0': '2026-01-01T00:00:00.000Z',
    })
  })

  it.each([
    ['no time', {}],
    ['a time that is not an object', { time: 'soon' }],
    ['a document that is not an object', ['x']],
  ])('returns an empty map for %s', async (_label, body) => {
    const server = await start(packument(body))

    expect(await fetchReleaseTimes('ms', configFor(server.url))).toEqual({})
  })

  it('asks the scope registry for a scoped package, with its own credentials (#104)', async () => {
    const corp = await start(
      packument({ time: { '1.0.0': '2026-02-01T00:00:00.000Z' } }),
    )
    const standard = await start(
      packument({ time: { '9.9.9': '2026-03-01T00:00:00.000Z' } }),
    )
    const config = configFor(standard.url, {
      scopedRegistries: { '@corp': corp.url },
      credentials: {
        [`//127.0.0.1:${corp.port}/`]: { authToken: 'SCOPED' },
        [`//127.0.0.1:${standard.port}/`]: { authToken: 'DEFAULT' },
      },
    })

    expect(await fetchReleaseTimes('@corp/pkg', config)).toEqual({
      '1.0.0': '2026-02-01T00:00:00.000Z',
    })
    expect(corp.requests.map((r) => [r.url, r.headers.authorization])).toEqual([
      ['/@corp%2fpkg', 'Bearer SCOPED'],
    ])
    expect(standard.requests).toEqual([])

    await fetchReleaseTimes('ms', config)
    expect(
      standard.requests.map((r) => [r.url, r.headers.authorization]),
    ).toEqual([['/ms', 'Bearer DEFAULT']])
    expect(corp.requests).toHaveLength(1)
  })

  it('asks again after the cache is cleared', async () => {
    const server = await start(packument({ time: {} }))
    const config = configFor(server.url)

    await fetchReleaseTimes('ms', config)
    clearRegistryCache()
    await fetchReleaseTimes('ms', config)

    expect(server.requests).toHaveLength(2)
  })
})
