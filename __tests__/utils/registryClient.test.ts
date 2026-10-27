import fs from 'fs'
import type http from 'http'
import os from 'os'
import path from 'path'
import tls from 'tls'
import zlib from 'zlib'
import type { RegistryConfig } from '@/types'
import { type Npmrc, parseNpmrc } from '@/utils/npmrc'
import {
  loadRegistryConfig,
  type NpmrcSources,
  registryConfigFrom,
} from '@/utils/npmrcLoader'
import {
  createRegistryClient,
  type RegistryClient,
  type RegistryClientOptions,
  RegistryRequestError,
} from '@/utils/registryClient'
import {
  conditional,
  readTls,
  registryBody,
  replies,
  startProxy,
  startRegistry,
  type TestProxy,
  type TestRegistry,
} from '../fixtures/registry'

const TLS_DIR = path.join(__dirname, '..', 'fixtures', 'tls')
const json =
  (body: unknown = { time: {} }) =>
  (_req: http.IncomingMessage, res: http.ServerResponse) => {
    res.setHeader('content-type', 'application/json')
    res.end(JSON.stringify(body))
  }
const never = () => undefined

describe('registry client', () => {
  let tmp: string
  let delays: number[]
  let clients: RegistryClient[]
  let registries: TestRegistry[]
  let proxies: TestProxy[]

  const sourcesFor = (env: NodeJS.ProcessEnv = {}): NpmrcSources => ({
    env,
    home: path.join(tmp, 'home'),
    // Node's own layout, so npm's default prefix is <tmp>/prefix on both:
    // node.exe sits in the prefix on Windows, in <prefix>/bin elsewhere.
    execPath:
      process.platform === 'win32'
        ? path.join(tmp, 'prefix', 'node.exe')
        : path.join(tmp, 'prefix', 'bin', 'node'),
    platform: process.platform,
  })

  const configFrom = (
    npmrc: string | Npmrc,
    env: NodeJS.ProcessEnv = {},
  ): RegistryConfig =>
    registryConfigFrom(
      typeof npmrc === 'string' ? parseNpmrc(npmrc, env) : npmrc,
      path.join(tmp, 'proj'),
      sourcesFor(env),
    )

  const clientFor = (
    config: RegistryConfig,
    lookup?: RegistryClientOptions['lookup'],
  ): RegistryClient => {
    const client = createRegistryClient(config, {
      sleep: (ms) => {
        delays.push(ms)
        return Promise.resolve()
      },
      lookup,
    })
    clients.push(client)
    return client
  }

  const registry = async (
    handler: Parameters<typeof startRegistry>[0] = json(),
    options?: Parameters<typeof startRegistry>[1],
  ) => {
    const started = await startRegistry(handler, options)
    registries.push(started)
    return started
  }

  const proxy = async (options?: Parameters<typeof startProxy>[0]) => {
    const started = await startProxy(options)
    proxies.push(started)
    return started
  }

  const get = (config: RegistryConfig, server: TestRegistry, name = 'pkg') =>
    clientFor(config).getJson(`${server.url}${name}`, server.url)

  const authOf = (server: TestRegistry) =>
    server.requests.map((r) => r.headers.authorization)

  const ca = JSON.stringify(readTls('ca.pem'))
  const clientCert = path.join(TLS_DIR, 'client.pem')
  const clientKey = path.join(TLS_DIR, 'client.key')

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'autd-client-')),
    )
    fs.mkdirSync(path.join(tmp, 'proj'))
    fs.writeFileSync(path.join(tmp, 'proj', 'package.json'), '{}')
    delays = []
    clients = []
    registries = []
    proxies = []
  })

  afterEach(async () => {
    for (const client of clients) client.destroy()
    await Promise.all([...registries, ...proxies].map((s) => s.close()))
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  describe('ca, ca[], cafile and strict-ssl', () => {
    it('rejects a server the default store does not trust, without retrying', async () => {
      const server = await registry(json(), { tls: 'server' })
      await expect(get(configFrom(''), server)).rejects.toBeInstanceOf(
        RegistryRequestError,
      )
      expect(server.requests).toHaveLength(0)
      expect(delays).toEqual([])
    })

    it('trusts a ca PEM string', async () => {
      const server = await registry(json({ ok: 1 }), { tls: 'server' })
      const config = configFrom({ ca: readTls('ca.pem') } as Npmrc)
      expect(await get(config, server)).toEqual({ ok: 1 })
    })

    it('trusts a double-quoted ca value with escaped newlines', async () => {
      const server = await registry(json({ ok: 2 }), { tls: 'server' })
      expect(await get(configFrom(`ca=${ca}`), server)).toEqual({ ok: 2 })
    })

    it('trusts ca[]', async () => {
      const server = await registry(json({ ok: 3 }), { tls: 'server' })
      expect(await get(configFrom(`ca[]=${ca}`), server)).toEqual({ ok: 3 })
    })

    it('reads cafile relative to the project', async () => {
      const server = await registry(json({ ok: 4 }), { tls: 'server' })
      const proj = path.join(tmp, 'proj')
      fs.writeFileSync(path.join(proj, 'ca.pem'), readTls('ca.pem'))
      fs.writeFileSync(path.join(proj, '.npmrc'), 'cafile="ca.pem"\n')
      const config = loadRegistryConfig(proj, sourcesFor())
      expect(await get(config, server)).toEqual({ ok: 4 })
    })

    it('reads cafile from the home directory with ~/', async () => {
      const server = await registry(json({ ok: 5 }), { tls: 'server' })
      const proj = path.join(tmp, 'proj')
      fs.mkdirSync(path.join(tmp, 'home'))
      fs.writeFileSync(path.join(tmp, 'home', 'ca.pem'), readTls('ca.pem'))
      fs.writeFileSync(path.join(proj, '.npmrc'), 'cafile="~/ca.pem"\n')
      const config = loadRegistryConfig(proj, sourcesFor())
      expect(await get(config, server)).toEqual({ ok: 5 })
    })

    it('prefers a readable cafile over a wrong ca', async () => {
      const server = await registry(json({ ok: 6 }), { tls: 'server' })
      const proj = path.join(tmp, 'proj')
      fs.writeFileSync(path.join(proj, 'ca.pem'), readTls('ca.pem'))
      fs.writeFileSync(
        path.join(proj, '.npmrc'),
        `cafile="ca.pem"\nca=${JSON.stringify(readTls('client.pem'))}\n`,
      )
      const config = loadRegistryConfig(proj, sourcesFor())
      expect(await get(config, server)).toEqual({ ok: 6 })
    })

    it('falls back to ca when the cafile is unreadable', async () => {
      const server = await registry(json({ ok: 7 }), { tls: 'server' })
      const config = configFrom(`cafile="missing.pem"\nca=${ca}`)
      expect(await get(config, server)).toEqual({ ok: 7 })
    })

    it('ignores a certificate error with strict-ssl=false', async () => {
      const server = await registry(json({ ok: 8 }), { tls: 'server' })
      expect(await get(configFrom('strict-ssl=false'), server)).toEqual({
        ok: 8,
      })
    })

    const withDefaultStore =
      typeof tls.setDefaultCACertificates === 'function' ? it : it.skip
    withDefaultStore(
      'uses the default store when no ca is configured',
      async () => {
        const server = await registry(json({ ok: 9 }), { tls: 'server' })
        const original = tls.getCACertificates('default')
        tls.setDefaultCACertificates([...original, readTls('ca.pem')])
        try {
          expect(await get(configFrom(''), server)).toEqual({ ok: 9 })
        } finally {
          tls.setDefaultCACertificates(original)
        }
      },
    )
  })

  describe('certfile and keyfile', () => {
    it('presents the client certificate scoped to the registry', async () => {
      const server = await registry(json(), { tls: 'mtls' })
      const prefix = `//127.0.0.1:${server.port}/`
      const config = configFrom(
        [
          `ca=${ca}`,
          `${prefix}:certfile=${JSON.stringify(clientCert)}`,
          `${prefix}:keyfile=${JSON.stringify(clientKey)}`,
        ].join('\n'),
      )
      await get(config, server)
      expect(server.requests.map((r) => r.clientCN)).toEqual([
        'autd test client',
      ])
    })

    it('is rejected without them', async () => {
      const server = await registry(json(), { tls: 'mtls' })
      await expect(
        get({ ...configFrom(`ca=${ca}`), fetchRetries: 0 }, server),
      ).rejects.toThrow()
      expect(server.requests).toHaveLength(0)
    })
  })

  describe('authentication', () => {
    it('sends _authToken as Bearer', async () => {
      const server = await registry()
      const config = configFrom(`//127.0.0.1:${server.port}/:_authToken=TOK`)
      await get(config, server)
      expect(authOf(server)).toEqual(['Bearer TOK'])
    })

    it('sends _auth as Basic, unchanged', async () => {
      const server = await registry()
      const config = configFrom(
        `//127.0.0.1:${server.port}/:_auth=dXNlcjpwYXNz`,
      )
      await get(config, server)
      expect(authOf(server)).toEqual(['Basic dXNlcjpwYXNz'])
    })

    it('builds Basic from username and the decoded _password', async () => {
      const server = await registry()
      const prefix = `//127.0.0.1:${server.port}/`
      const password = Buffer.from('pass').toString('base64')
      await get(
        configFrom(`${prefix}:username=user\n${prefix}:_password=${password}`),
        server,
      )
      expect(authOf(server)).toEqual([
        `Basic ${Buffer.from('user:pass').toString('base64')}`,
      ])
    })

    it('sends the token of the longest matching prefix', async () => {
      const server = await registry()
      const prefix = `//127.0.0.1:${server.port}/`
      const base = `${server.url}npm/repo/`
      const config = configFrom(
        `registry=${base}\n${prefix}:_authToken=HOST\n${prefix}npm/repo/:_authToken=REPO`,
      )
      await clientFor(config).getJson(`${base}pkg`, base)
      expect(authOf(server)).toEqual(['Bearer REPO'])
    })

    it('does not send a token scoped to another port', async () => {
      const server = await registry()
      const config = configFrom(
        `//127.0.0.1:${server.port + 1}/:_authToken=OTHER`,
      )
      await get(config, server)
      expect(authOf(server)).toEqual([undefined])
    })

    it('does not send an unscoped _authToken', async () => {
      const server = await registry()
      await get(configFrom('_authToken=UNSCOPED'), server)
      expect(authOf(server)).toEqual([undefined])
    })

    it('sends registry URL userinfo as Basic auth, never in the URL', async () => {
      const server = await registry()
      const base = `http://us%40er:p%3Ass@127.0.0.1:${server.port}/`
      await clientFor(configFrom('')).getJson(`${base}pkg`, base)
      expect(authOf(server)).toEqual([
        `Basic ${Buffer.from('us@er:p:ss').toString('base64')}`,
      ])
      expect(server.requests[0].url).toBe('/pkg')
    })

    it('prefers credentials scoped to the prefix over URL userinfo', async () => {
      const server = await registry()
      const base = `http://user:pw@127.0.0.1:${server.port}/`
      const config = configFrom(`//127.0.0.1:${server.port}/:_authToken=TOK`)
      await clientFor(config).getJson(`${base}pkg`, base)
      expect(authOf(server)).toEqual(['Bearer TOK'])
    })

    it('never puts URL userinfo or the query in an error', async () => {
      const server = await registry((_req, res) => {
        res.statusCode = 404
        res.end()
      })
      const url = `http://user:secret@127.0.0.1:${server.port}/pkg?token=q`
      const error = await clientFor(configFrom(''))
        .getJson(url, server.url)
        .catch((e: unknown) => e)
      expect(error).toBeInstanceOf(RegistryRequestError)
      expect(String((error as Error).message)).not.toMatch(/secret|token=q/)
    })

    it('still sends the token when the certfile or keyfile is missing', async () => {
      const server = await registry(json({ ok: 'noclient' }), { tls: 'server' })
      const prefix = `//127.0.0.1:${server.port}/`
      const config = configFrom(
        [
          `ca=${ca}`,
          `${prefix}:_authToken=TOK`,
          `${prefix}:certfile=missing-cert.pem`,
          `${prefix}:keyfile=missing-key.pem`,
        ].join('\n'),
      )
      expect(await get(config, server)).toEqual({ ok: 'noclient' })
      expect(authOf(server)).toEqual(['Bearer TOK'])
    })
  })

  describe('redirects', () => {
    it('follows a same-host redirect and recomputes the credentials', async () => {
      const server = await registry((req, res) => {
        if (req.url === '/pkg') {
          res.statusCode = 302
          res.setHeader('location', '/final/pkg')
          res.end()
          return
        }
        json({ done: true })(req, res)
      })
      const prefix = `//127.0.0.1:${server.port}/`
      const config = configFrom(
        `${prefix}:_authToken=HOST\n${prefix}final/:_authToken=FINAL`,
      )
      expect(await get(config, server)).toEqual({ done: true })
      expect(authOf(server)).toEqual(['Bearer HOST', 'Bearer FINAL'])
    })

    it('drops the token on a redirect to another port', async () => {
      const target = await registry()
      const server = await registry((_req, res) => {
        res.statusCode = 302
        res.setHeader('location', `${target.url}pkg`)
        res.end()
      })
      const config = configFrom(`//127.0.0.1:${server.port}/:_authToken=TOK`)
      await get(config, server)
      expect(authOf(server)).toEqual(['Bearer TOK'])
      expect(authOf(target)).toEqual([undefined])
    })

    it('keeps the requested Accept across a redirect', async () => {
      const server = await registry((req, res) => {
        if (req.url === '/pkg') {
          res.statusCode = 302
          res.setHeader('location', '/final/pkg')
          res.end()
          return
        }
        json({ done: true })(req, res)
      })
      await clientFor(configFrom('')).getJson(`${server.url}pkg`, server.url, {
        accept: 'text/x-test',
      })
      expect(server.requests.map((r) => r.headers.accept)).toEqual([
        'text/x-test',
        'text/x-test',
      ])
    })

    it('refuses a redirect from https to http', async () => {
      const target = await registry()
      const server = await registry(
        (_req, res) => {
          res.statusCode = 302
          res.setHeader('location', `${target.url}pkg`)
          res.end()
        },
        { tls: 'server' },
      )
      await expect(get(configFrom(`ca=${ca}`), server)).rejects.toThrow(
        /refused redirect/,
      )
      expect(target.requests).toHaveLength(0)
    })

    it('turns a malformed Location into a redacted error, without retrying', async () => {
      const server = await registry((_req, res) => {
        res.statusCode = 302
        res.setHeader('location', 'http://[secret-host')
        res.end()
      })
      const error = await get(configFrom(''), server).catch((e: unknown) => e)
      expect(error).toBeInstanceOf(RegistryRequestError)
      expect((error as Error).message).toMatch(/invalid location/)
      expect((error as Error).message).not.toMatch(/secret-host/)
      expect(server.requests).toHaveLength(1)
      expect(delays).toEqual([])
    })

    it('gives up after five redirects', async () => {
      const server = await registry((_req, res) => {
        res.statusCode = 302
        res.setHeader('location', '/again')
        res.end()
      })
      await expect(get(configFrom(''), server)).rejects.toThrow(
        /too many redirects/,
      )
      expect(server.requests).toHaveLength(6)
    })
  })

  describe('proxies', () => {
    const secure = async () => registry(json({ ok: 'via' }), { tls: 'server' })

    it('tunnels https-proxy with decoded proxy credentials', async () => {
      const server = await secure()
      const via = await proxy()
      const config = configFrom(
        `ca=${ca}\nhttps-proxy=http://u%40corp:p%3Ass@127.0.0.1:${via.port}`,
      )
      expect(await get(config, server)).toEqual({ ok: 'via' })
      expect(via.seen).toEqual([
        {
          method: 'CONNECT',
          target: `127.0.0.1:${server.port}`,
          proxyAuthorization: `Basic ${Buffer.from('u@corp:p:ss').toString('base64')}`,
        },
      ])
    })

    it('uses proxy for HTTPS when it is the only setting', async () => {
      const server = await secure()
      const via = await proxy()
      const config = configFrom(`ca=${ca}\nproxy=http://127.0.0.1:${via.port}`)
      await get(config, server)
      expect(via.seen.map((r) => r.method)).toEqual(['CONNECT'])
    })

    it('falls back to HTTPS_PROXY from the environment', async () => {
      const server = await secure()
      const via = await proxy()
      const config = configFrom(`ca=${ca}`, {
        HTTPS_PROXY: `http://127.0.0.1:${via.port}`,
      })
      await get(config, server)
      expect(via.seen.map((r) => r.method)).toEqual(['CONNECT'])
    })

    it('prefers a lower-case https_proxy over HTTPS_PROXY', async () => {
      const server = await secure()
      const lower = await proxy()
      const upper = await proxy()
      const config = configFrom(`ca=${ca}`, {
        https_proxy: `http://127.0.0.1:${lower.port}`,
        HTTPS_PROXY: `http://127.0.0.1:${upper.port}`,
      })
      await get(config, server)
      expect(lower.seen).toHaveLength(1)
      expect(upper.seen).toHaveLength(0)
    })

    it('prefers .npmrc https-proxy over the environment', async () => {
      const server = await secure()
      const fromNpmrc = await proxy()
      const fromEnv = await proxy()
      const config = configFrom(
        `ca=${ca}\nhttps-proxy=http://127.0.0.1:${fromNpmrc.port}`,
        { HTTPS_PROXY: `http://127.0.0.1:${fromEnv.port}` },
      )
      await get(config, server)
      expect(fromNpmrc.seen).toHaveLength(1)
      expect(fromEnv.seen).toHaveLength(0)
    })

    it('bypasses the proxy for a noproxy host', async () => {
      const server = await secure()
      const via = await proxy()
      const config = configFrom(
        `ca=${ca}\nhttps-proxy=http://127.0.0.1:${via.port}\nnoproxy=127.0.0.1`,
      )
      expect(await get(config, server)).toEqual({ ok: 'via' })
      expect(via.seen).toEqual([])
    })

    it('applies NO_PROXY from the environment', async () => {
      const server = await secure()
      const via = await proxy()
      const config = configFrom(`ca=${ca}`, {
        HTTPS_PROXY: `http://127.0.0.1:${via.port}`,
        NO_PROXY: '127.0.0.1',
      })
      await get(config, server)
      expect(via.seen).toEqual([])
    })

    it('lets .npmrc noproxy override NO_PROXY', async () => {
      const server = await secure()
      const via = await proxy()
      const config = configFrom(
        `ca=${ca}\nnoproxy=other.test\nhttps-proxy=http://127.0.0.1:${via.port}`,
        { NO_PROXY: '127.0.0.1' },
      )
      await get(config, server)
      expect(via.seen.map((r) => r.method)).toEqual(['CONNECT'])
    })

    describe('suffix matching on an http registry', () => {
      const resolveToLoopback = ((
        _host: string,
        _options: unknown,
        callback: (
          error: null,
          address: string | { address: string; family: number }[],
          family?: number,
        ) => void,
      ) => {
        callback(null, [{ address: '127.0.0.1', family: 4 }])
      }) as unknown as RegistryClientOptions['lookup']

      const run = async (noproxy: string) => {
        const server = await registry(json({ ok: 'host' }))
        const via = await proxy({
          forward: () => ({ host: '127.0.0.1', port: server.port }),
        })
        const base = `http://registry.example.test:${server.port}/`
        const config = configFrom(
          `registry=${base}\nproxy=http://127.0.0.1:${via.port}\nnoproxy=${noproxy}`,
        )
        const result = await clientFor(config, resolveToLoopback).getJson(
          `${base}pkg`,
          base,
        )
        return { result, via, server, base }
      }

      it('goes direct when noproxy is a suffix of the host', async () => {
        const { result, via, server } = await run('example.test')
        expect(result).toEqual({ ok: 'host' })
        expect(via.seen).toEqual([])
        expect(server.requests).toHaveLength(1)
      })

      it('goes through the proxy otherwise', async () => {
        const { result, via, base } = await run('other.test')
        expect(result).toEqual({ ok: 'host' })
        expect(via.seen.map((r) => [r.method, r.target])).toEqual([
          ['GET', `${base}pkg`],
        ])
      })
    })
  })

  describe('fetch-retries and Retry-After', () => {
    const sequence = (...statuses: number[]) => {
      let call = 0
      return (req: http.IncomingMessage, res: http.ServerResponse) => {
        const status = statuses[Math.min(call++, statuses.length - 1)]
        if (status === 200) return json({ ok: true })(req, res)
        res.statusCode = status
        res.end()
      }
    }

    it('retries a 503 with backoff', async () => {
      const server = await registry(sequence(503, 503, 200))
      expect(await get(configFrom(''), server)).toEqual({ ok: true })
      expect(server.requests).toHaveLength(3)
      expect(delays).toEqual([100, 200])
    })

    it('waits as long as a short Retry-After says', async () => {
      let call = 0
      const server = await registry((req, res) => {
        if (call++ === 0) {
          res.statusCode = 429
          res.setHeader('retry-after', '1')
          res.end()
          return
        }
        json({ ok: true })(req, res)
      })
      await get(configFrom(''), server)
      expect(delays).toEqual([1000])
    })

    it('waits for a Retry-After of up to ten seconds', async () => {
      let call = 0
      const server = await registry((req, res) => {
        if (call++ === 0) {
          res.statusCode = 503
          res.setHeader('retry-after', '10')
          res.end()
          return
        }
        json({ ok: true })(req, res)
      })
      await get(configFrom(''), server)
      expect(delays).toEqual([10_000])
    })

    it('stops at a Retry-After over the cap', async () => {
      const server = await registry((_req, res) => {
        res.statusCode = 429
        res.setHeader('retry-after', '11')
        res.end()
      })
      await expect(get(configFrom(''), server)).rejects.toMatchObject({
        status: 429,
      })
      expect(server.requests).toHaveLength(1)
      expect(delays).toEqual([])
    })

    it('does not retry a 404', async () => {
      const server = await registry(sequence(404))
      await expect(get(configFrom(''), server)).rejects.toMatchObject({
        status: 404,
      })
      expect(server.requests).toHaveLength(1)
    })

    it('lets a request override fetch-retries with its own retries', async () => {
      const server = await registry(sequence(503, 200))
      await expect(
        clientFor(configFrom('fetch-retries=2')).getJson(
          `${server.url}pkg`,
          server.url,
          { retries: 0 },
        ),
      ).rejects.toMatchObject({ status: 503 })
      expect(server.requests).toHaveLength(1)
      expect(delays).toEqual([])
    })

    it('makes one request with fetch-retries=0', async () => {
      const server = await registry(sequence(503, 200))
      await expect(
        get(configFrom('fetch-retries=0'), server),
      ).rejects.toMatchObject({ status: 503 })
      expect(server.requests).toHaveLength(1)
      expect(delays).toEqual([])
    })

    it('retries a connection reset', async () => {
      let call = 0
      const server = await registry((req, res) => {
        if (call++ === 0) {
          req.socket.destroy()
          return
        }
        json({ ok: true })(req, res)
      })
      expect(await get(configFrom(''), server)).toEqual({ ok: true })
      expect(delays).toEqual([100])
    })

    it('tries three times against a closed port', async () => {
      const server = await registry()
      await server.close()
      await expect(get(configFrom(''), server)).rejects.toMatchObject({
        code: 'ECONNREFUSED',
      })
      expect(delays).toEqual([100, 200])
    })
  })

  describe('fetch-timeout', () => {
    it('times out a server that never answers, after its retries', async () => {
      const server = await registry(never)
      await expect(
        get(configFrom('fetch-timeout=100\nfetch-retries=1'), server),
      ).rejects.toMatchObject({ code: 'ETIMEDOUT' })
      expect(server.requests).toHaveLength(2)
      expect(delays).toEqual([100])
    })

    it('lets a per-request timeout override fetch-timeout', async () => {
      const server = await registry(never)
      const started = Date.now()
      await expect(
        clientFor(configFrom('fetch-timeout=60000\nfetch-retries=0')).getJson(
          `${server.url}pkg`,
          server.url,
          { timeout: 100 },
        ),
      ).rejects.toMatchObject({
        code: 'ETIMEDOUT',
        message: expect.stringContaining('timed out after 100ms'),
      })
      expect(Date.now() - started).toBeLessThan(5000)
    })

    it('times out a body that stalls after the headers', async () => {
      const server = await registry((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.write('{"time":')
      })
      await expect(
        get(configFrom('fetch-timeout=100\nfetch-retries=0'), server),
      ).rejects.toMatchObject({ code: 'ETIMEDOUT' })
    })
  })

  describe('maxsockets', () => {
    it('queues requests beyond the limit', async () => {
      const server = await registry((req, res) => {
        setTimeout(() => json()(req, res), 50)
      })
      const client = clientFor(configFrom('maxsockets=1'))
      await Promise.all(
        ['a', 'b', 'c'].map((name) =>
          client.getJson(`${server.url}${name}`, server.url),
        ),
      )
      expect(server.requests).toHaveLength(3)
      expect(server.peak).toBe(1)
    })
  })

  describe('transport', () => {
    it('reuses one connection for sequential requests', async () => {
      const server = await registry()
      const client = clientFor(configFrom(''))
      await client.getJson(`${server.url}a`, server.url)
      await client.getJson(`${server.url}b`, server.url)
      expect(server.connections).toBe(1)
    })

    it('asks for JSON and gzip, and decodes a gzip body', async () => {
      const server = await registry((_req, res) => {
        res.setHeader('content-encoding', 'gzip')
        res.end(zlib.gzipSync(JSON.stringify({ zipped: true })))
      })
      expect(await get(configFrom(''), server)).toEqual({ zipped: true })
      const [seen] = server.requests
      expect(seen.headers.accept).toBe('application/json')
      expect(seen.headers['accept-encoding']).toBe('gzip')
      expect(seen.headers['user-agent']).toMatch(
        /^always-up-to-date\/\S+ node\/v\d+/,
      )
    })

    it('sends the Accept it is given', async () => {
      const server = await registry()
      await clientFor(configFrom('')).getJson(`${server.url}pkg`, server.url, {
        accept: 'application/vnd.npm.install-v1+json',
      })
      expect(server.requests[0].headers.accept).toBe(
        'application/vnd.npm.install-v1+json',
      )
    })

    it('rejects an unsupported content-encoding without retrying', async () => {
      const server = await registry((_req, res) => {
        res.setHeader('content-encoding', 'br')
        res.end('x')
      })
      await expect(get(configFrom(''), server)).rejects.toThrow(
        /content-encoding/,
      )
      expect(server.requests).toHaveLength(1)
    })

    it('rejects a body that is not JSON without retrying', async () => {
      const server = await registry((_req, res) => {
        res.end('<html>')
      })
      await expect(get(configFrom(''), server)).rejects.toThrow(
        /not valid JSON/,
      )
      expect(server.requests).toHaveLength(1)
    })

    it('stops when the caller aborts', async () => {
      const server = await registry(never)
      const controller = new AbortController()
      const pending = clientFor(configFrom('')).getJson(
        `${server.url}pkg`,
        server.url,
        { signal: controller.signal },
      )
      setTimeout(() => controller.abort(), 50)
      await expect(pending).rejects.toBeInstanceOf(RegistryRequestError)
    })

    it('talks to an http registry', async () => {
      const server = await registry(json({ plain: true }))
      expect(await get(configFrom(''), server)).toEqual({ plain: true })
    })
  })

  describe('validators and getResponse', () => {
    const body = registryBody('ms.packument')
    const parsed: unknown = JSON.parse(body)
    const type = 'application/vnd.npm.install-v1+json'
    const ETAG = 'W/"test-etag-1"'
    const CACHE = 'public, max-age=300'

    it('returns the ETag and Cache-Control', async () => {
      const server = await registry(
        replies({
          '/pkg': {
            type,
            body,
            headers: { etag: ETAG, 'cache-control': CACHE },
          },
        }),
      )
      const response = await clientFor(configFrom('')).getResponse(
        `${server.url}pkg`,
        server.url,
      )
      expect(response).toEqual({
        notModified: false,
        body: parsed,
        etag: ETAG,
        cacheControl: CACHE,
        authenticated: false,
      })
    })

    it('leaves them out when the registry sends none', async () => {
      const server = await registry(replies({ '/pkg': { body } }))
      const response = await clientFor(configFrom('')).getResponse(
        `${server.url}pkg`,
        server.url,
      )
      expect(response).toMatchObject({ notModified: false, body: parsed })
      expect(response).toMatchObject({
        etag: undefined,
        cacheControl: undefined,
      })
    })

    it('sends if-none-match only when given', async () => {
      const server = await registry(replies({ '/pkg': { body } }))
      const client = clientFor(configFrom(''))
      await client.getResponse(`${server.url}pkg`, server.url)
      await client.getResponse(`${server.url}pkg`, server.url, {
        ifNoneMatch: ETAG,
      })
      expect(server.requests.map((r) => r.headers['if-none-match'])).toEqual([
        undefined,
        ETAG,
      ])
    })

    it('keeps if-none-match across a redirect', async () => {
      const server = await registry((req, res) => {
        if (req.url === '/pkg') {
          res.statusCode = 302
          res.setHeader('location', '/final/pkg')
          res.end()
          return
        }
        json({ done: true })(req, res)
      })
      await clientFor(configFrom('')).getResponse(
        `${server.url}pkg`,
        server.url,
        {
          ifNoneMatch: ETAG,
        },
      )
      expect(server.requests.map((r) => r.headers['if-none-match'])).toEqual([
        ETAG,
        ETAG,
      ])
    })

    it('returns a 304 to a conditional request without a body, and counts it', async () => {
      const server = await registry(
        conditional({ type, body, headers: { 'cache-control': CACHE } }, ETAG),
      )
      const client = clientFor(configFrom(''))
      const response = await client.getResponse(
        `${server.url}pkg`,
        server.url,
        {
          ifNoneMatch: ETAG,
        },
      )
      expect(response).toEqual({
        notModified: true,
        etag: ETAG,
        cacheControl: CACHE,
        authenticated: false,
      })
      expect(client.stats()).toEqual({
        [`127.0.0.1:${server.port}`]: {
          responses: 1,
          bodyBytes: 0,
          decodedBytes: 0,
        },
      })
    })

    it('answers 200 with the body and the new ETag when the validator is stale', async () => {
      const server = await registry(conditional({ type, body }, ETAG))
      const response = await clientFor(configFrom('')).getResponse(
        `${server.url}pkg`,
        server.url,
        { ifNoneMatch: 'W/"old"' },
      )
      expect(response).toMatchObject({
        notModified: false,
        body: parsed,
        etag: ETAG,
      })
    })

    it('still rejects a 304 nobody asked for, in getResponse and getJson', async () => {
      const server = await registry((_req, res) => {
        res.statusCode = 304
        res.end()
      })
      const client = clientFor({ ...configFrom(''), fetchRetries: 0 })
      await expect(
        client.getResponse(`${server.url}pkg`, server.url),
      ).rejects.toMatchObject({ status: 304 })
      await expect(
        client.getJson(`${server.url}pkg`, server.url),
      ).rejects.toMatchObject({ status: 304 })
    })

    it('getJson returns the body of a conditional 200 as before', async () => {
      const server = await registry(conditional({ type, body }, ETAG))
      expect(
        await clientFor(configFrom('')).getJson(`${server.url}pkg`, server.url),
      ).toEqual(parsed)
    })

    describe('authenticated', () => {
      const authenticatedOf = async (
        config: RegistryConfig,
        server: TestRegistry,
        url = `${server.url}pkg`,
      ) => (await clientFor(config).getResponse(url, server.url)).authenticated

      it('is true with an _authToken', async () => {
        const server = await registry()
        const config = configFrom(`//127.0.0.1:${server.port}/:_authToken=TOK`)
        expect(await authenticatedOf(config, server)).toBe(true)
      })

      it('is true with _auth', async () => {
        const server = await registry()
        const config = configFrom(
          `//127.0.0.1:${server.port}/:_auth=dXNlcjpwYXNz`,
        )
        expect(await authenticatedOf(config, server)).toBe(true)
      })

      it('is true with userinfo in the URL', async () => {
        const server = await registry()
        const url = `${server.url.replace('//', '//user:pass@')}pkg`
        expect(await authenticatedOf(configFrom(''), server, url)).toBe(true)
        expect(authOf(server)).toEqual([
          `Basic ${Buffer.from('user:pass').toString('base64')}`,
        ])
      })

      it('is true with a client certificate', async () => {
        const server = await registry(json(), { tls: 'mtls' })
        const prefix = `//127.0.0.1:${server.port}/`
        const config = configFrom(
          [
            `ca=${ca}`,
            `${prefix}:certfile=${JSON.stringify(clientCert)}`,
            `${prefix}:keyfile=${JSON.stringify(clientKey)}`,
          ].join('\n'),
        )
        expect(await authenticatedOf(config, server)).toBe(true)
      })

      it('is false with no credentials', async () => {
        const server = await registry()
        expect(await authenticatedOf(configFrom(''), server)).toBe(false)
      })

      it('is true when a hop that was redirected away carried credentials', async () => {
        const target = await registry()
        const server = await registry((_req, res) => {
          res.statusCode = 302
          res.setHeader('location', `${target.url}pkg`)
          res.end()
        })
        const config = configFrom(`//127.0.0.1:${server.port}/:_authToken=TOK`)
        expect(await authenticatedOf(config, server)).toBe(true)
        expect(authOf(target)).toEqual([undefined])
      })
    })

    describe('the ETag guard', () => {
      const etagOf = async (value: string) => {
        const server = await registry((_req, res) => {
          res.setHeader('etag', value)
          json({ ok: true })(_req, res)
        })
        const response = await clientFor(configFrom('')).getResponse(
          `${server.url}pkg`,
          server.url,
        )
        return response.etag
      }

      it('keeps a printable ASCII ETag of up to 1024 characters', async () => {
        const longest = `"${'a'.repeat(1022)}"`
        expect(await etagOf(longest)).toBe(longest)
      })

      it('drops one over 1024 characters', async () => {
        expect(await etagOf(`"${'a'.repeat(1023)}"`)).toBeUndefined()
      })

      it('drops one with a tab or a non-ASCII character', async () => {
        expect(await etagOf('"a\tb"')).toBeUndefined()
        expect(await etagOf('"caf\u00e9"')).toBeUndefined()
      })

      it('drops an empty one', async () => {
        expect(await etagOf('')).toBeUndefined()
      })
    })
  })

  describe('stats', () => {
    it('counts the gzip bytes received and the bytes after gunzip', async () => {
      const raw = JSON.stringify({ pad: 'x'.repeat(5000) })
      const zipped = zlib.gzipSync(raw)
      const server = await registry((_req, res) => {
        res.setHeader('content-encoding', 'gzip')
        res.end(zipped)
      })
      const client = clientFor(configFrom(''))
      await client.getJson(`${server.url}pkg`, server.url)
      expect(client.stats()).toEqual({
        [`127.0.0.1:${server.port}`]: {
          responses: 1,
          bodyBytes: zipped.length,
          decodedBytes: Buffer.byteLength(raw),
        },
      })
    })

    it('returns copies: an earlier snapshot does not change', async () => {
      const server = await registry(json({ ok: true }))
      const client = clientFor(configFrom(''))
      await client.getJson(`${server.url}a`, server.url)
      const before = client.stats()
      const key = `127.0.0.1:${server.port}`
      expect(before[key]?.responses).toBe(1)

      await client.getJson(`${server.url}b`, server.url)

      expect(before[key]?.responses).toBe(1)
      expect(client.stats()[key]?.responses).toBe(2)
    })

    it('counts a 404 as a response and nothing else', async () => {
      const server = await registry((_req, res) => {
        res.statusCode = 404
        res.end('not here')
      })
      const client = clientFor(configFrom(''))
      await expect(
        client.getJson(`${server.url}pkg`, server.url),
      ).rejects.toMatchObject({ status: 404 })
      expect(client.stats()).toEqual({
        [`127.0.0.1:${server.port}`]: {
          responses: 1,
          bodyBytes: 0,
          decodedBytes: 0,
        },
      })
    })
  })

  describe('layering reaches the wire', () => {
    it('sends the token of the highest layer, then the next as layers go', async () => {
      const server = await registry()
      const proj = path.join(tmp, 'proj')
      const key = `//127.0.0.1:${server.port}/:_authToken`
      const files = {
        global: path.join(tmp, 'prefix', 'etc', 'npmrc'),
        user: path.join(tmp, 'home', '.npmrc'),
        project: path.join(proj, '.npmrc'),
      }
      for (const [layer, file] of Object.entries(files)) {
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, `${key}=${layer.toUpperCase()}\n`)
      }
      const env = { [`npm_config_${key}`]: 'ENV' }
      const tokenFor = async (withEnv: boolean) => {
        server.requests.length = 0
        const config = loadRegistryConfig(proj, sourcesFor(withEnv ? env : {}))
        await get(config, server)
        return authOf(server)[0]
      }

      expect(await tokenFor(true)).toBe('Bearer ENV')
      expect(await tokenFor(false)).toBe('Bearer PROJECT')
      fs.rmSync(files.project)
      expect(await tokenFor(false)).toBe('Bearer USER')
      fs.rmSync(files.user)
      expect(await tokenFor(false)).toBe('Bearer GLOBAL')
    })
  })
})
