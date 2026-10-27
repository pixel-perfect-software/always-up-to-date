import fs from 'fs'
import http from 'http'
import https from 'https'
import net from 'net'
import path from 'path'
import type { TLSSocket } from 'tls'
import zlib from 'zlib'

/** Reads one of the committed test-only PEMs in `fixtures/tls/`. */
export const readTls = (
  name: 'ca.pem' | 'server.pem' | 'server.key' | 'client.pem' | 'client.key',
): string => fs.readFileSync(path.join(__dirname, 'tls', name), 'utf8')

/**
 * A captured response body, verbatim, from `fixtures/registry/<name>.body`, or
 * gunzipped from `<name>.body.gz` (bodies over 100 KB decoded are committed so).
 */
export const registryBody = (name: string): string => {
  const file = path.join(__dirname, 'registry', `${name}.body`)
  return fs.existsSync(file)
    ? fs.readFileSync(file, 'utf8')
    : zlib.gunzipSync(fs.readFileSync(`${file}.gz`)).toString('utf8')
}

/**
 * A captured JSON body, parsed, edited and stringified again: how a test gets
 * a variant (a version dropped, a field missing) without hand-writing one.
 */
export const derive = <T>(name: string, edit: (body: T) => void): string => {
  const body = JSON.parse(registryBody(name)) as T
  edit(body)
  return JSON.stringify(body)
}

export interface Reply {
  status?: number
  type?: string
  /** Extra response headers; values are opaque test strings. */
  headers?: Record<string, string>
  body: string
}

const send = (res: http.ServerResponse, reply: Reply): void => {
  res.statusCode = reply.status ?? 200
  res.setHeader('content-type', reply.type ?? 'application/json')
  for (const [name, value] of Object.entries(reply.headers ?? {})) {
    res.setHeader(name, value)
  }
  res.end(reply.body)
}

/** Answers from an exact `req.url` to reply table; anything else is 404 text/plain. */
export const replies =
  (table: Record<string, Reply>): Handler =>
  (req, res) => {
    const reply = table[req.url ?? '']
    if (reply) send(res, reply)
    else send(res, { status: 404, type: 'text/plain', body: 'not found' })
  }

/**
 * Answers `reply` with `ETag: etag`, or a bodiless 304 (same ETag, same extra
 * headers) when the request's `If-None-Match` is that etag.
 */
export const conditional =
  (reply: Reply, etag: string): Handler =>
  (req, res) => {
    const headers = { ...reply.headers, etag }
    if (req.headers['if-none-match'] === etag) {
      res.statusCode = 304
      for (const [name, value] of Object.entries(headers)) {
        res.setHeader(name, value)
      }
      res.end()
      return
    }
    send(res, { ...reply, headers })
  }

export interface RecordedRequest {
  url: string
  headers: http.IncomingHttpHeaders
  /** The client certificate's CN, when the server asked for one. */
  clientCN?: string
}

export interface TestRegistry {
  url: string
  port: number
  requests: RecordedRequest[]
  /** TCP (or TLS) connections accepted so far. */
  connections: number
  /** The most requests in flight at once. */
  peak: number
  close(): Promise<void>
}

export type Handler = (
  req: http.IncomingMessage,
  res: http.ServerResponse,
) => void

const listen = (server: net.Server): Promise<number> =>
  new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve((server.address() as net.AddressInfo).port)
    })
  })

const closeServer = (
  server: http.Server,
  open: Set<net.Socket>,
): Promise<void> =>
  new Promise((resolve) => {
    server.closeAllConnections()
    for (const socket of open) socket.destroy()
    server.close(() => resolve())
  })

/**
 * A registry on 127.0.0.1 with a random port. `tls: 'server'` serves HTTPS
 * with a certificate the test CA signed; `'mtls'` also demands a client
 * certificate from that CA.
 */
export const startRegistry = async (
  handler: Handler,
  options: { tls?: 'server' | 'mtls' } = {},
): Promise<TestRegistry> => {
  const requests: RecordedRequest[] = []
  const open = new Set<net.Socket>()
  let inFlight = 0

  const onRequest: Handler = (req, res) => {
    const peer = (req.socket as TLSSocket).getPeerCertificate?.()
    const cn = peer?.subject?.CN
    requests.push({
      url: req.url ?? '',
      headers: req.headers,
      clientCN: Array.isArray(cn) ? cn[0] : cn,
    })
    registry.peak = Math.max(registry.peak, ++inFlight)
    res.on('close', () => {
      inFlight--
    })
    handler(req, res)
  }

  const server = options.tls
    ? https.createServer(
        {
          cert: readTls('server.pem'),
          key: readTls('server.key'),
          ...(options.tls === 'mtls'
            ? {
                ca: readTls('ca.pem'),
                requestCert: true,
                rejectUnauthorized: true,
              }
            : {}),
        },
        onRequest,
      )
    : http.createServer(onRequest)

  server.on(options.tls ? 'secureConnection' : 'connection', (socket) => {
    registry.connections++
    open.add(socket)
    socket.on('close', () => open.delete(socket))
  })

  const port = await listen(server)
  const registry: TestRegistry = {
    url: `${options.tls ? 'https' : 'http'}://127.0.0.1:${port}/`,
    port,
    requests,
    connections: 0,
    peak: 0,
    close: () => closeServer(server, open),
  }
  return registry
}

export interface ProxyRecord {
  method: 'GET' | 'CONNECT'
  /** The absolute URI of a GET, or `host:port` of a CONNECT. */
  target: string
  proxyAuthorization?: string
}

export interface TestProxy {
  url: string
  port: number
  seen: ProxyRecord[]
  close(): Promise<void>
}

/**
 * A forward proxy: answers plain `GET http://...` itself (recording the
 * absolute URI) and tunnels `CONNECT` to its target.
 */
export const startProxy = async (
  options: { forward?: (target: URL) => { host: string; port: number } } = {},
): Promise<TestProxy> => {
  const seen: ProxyRecord[] = []
  const open = new Set<net.Socket>()

  const server = http.createServer((req, res) => {
    seen.push({
      method: 'GET',
      target: req.url ?? '',
      proxyAuthorization: req.headers['proxy-authorization']?.toString(),
    })
    const target = new URL(req.url ?? '')
    const to = options.forward?.(target) ?? {
      host: target.hostname,
      port: Number(target.port),
    }
    const upstream = http.request(
      {
        host: to.host,
        port: to.port,
        path: target.pathname,
        headers: req.headers,
      },
      (response) => {
        res.writeHead(response.statusCode ?? 502, response.headers)
        response.pipe(res)
      },
    )
    upstream.on('error', () => res.destroy())
    upstream.end()
  })

  server.on('connection', (socket) => {
    open.add(socket)
    socket.on('close', () => open.delete(socket))
  })

  server.on('connect', (req, socket, head) => {
    seen.push({
      method: 'CONNECT',
      target: req.url ?? '',
      proxyAuthorization: req.headers['proxy-authorization']?.toString(),
    })
    const [host, port] = (req.url ?? '').split(':')
    const upstream = net.connect(Number(port), host, () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      upstream.write(head)
      upstream.pipe(socket)
      socket.pipe(upstream)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
  })

  const port = await listen(server)
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    seen,
    close: () => closeServer(server, open),
  }
}
