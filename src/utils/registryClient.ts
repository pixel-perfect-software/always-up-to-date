import fs from 'fs'
import http from 'http'
import https from 'https'
import type net from 'net'
import { pipeline } from 'stream/promises'
import { setTimeout as sleepFor } from 'timers/promises'
import zlib from 'zlib'
import type { RegistryConfig, RegistryCredentials } from '@/types'
import packageJson from '../../package.json'
import logger from './logger'
import {
  authorizationFor,
  credentialsFor,
  decodeUri,
  isRetryableError,
  isRetryableStatus,
  retryDelay,
} from './registryRequest'

/** What a GET came back with; `authenticated` is true when any hop sent credentials. */
export type RegistryResponse =
  | {
      notModified: false
      body: unknown
      etag?: string
      cacheControl?: string
      /** Seconds the answer already aged in caches on its way (`Age`). */
      age?: number
      authenticated: boolean
    }
  | {
      notModified: true
      etag?: string
      cacheControl?: string
      /** Seconds the answer already aged in caches on its way (`Age`). */
      age?: number
      authenticated: boolean
    }

export interface RegistryRequestOptions {
  signal?: AbortSignal
  accept?: string
  timeout?: number
  retries?: number
}

export interface RegistryClient {
  /**
   * As getJson, plus the validators. A 304 is returned (`notModified`) only
   * when `ifNoneMatch` was sent; otherwise it stays an error.
   */
  getResponse(
    url: string,
    registry: string,
    options?: RegistryRequestOptions & { ifNoneMatch?: string },
  ): Promise<RegistryResponse>
  /**
   * GET url as JSON with the credentials and agent for its registry; rejects
   * with RegistryRequestError. `accept` (default `application/json`),
   * `timeout` (default `fetch-timeout`, in ms) and `retries` (default
   * `fetch-retries`) are per request.
   */
  getJson(
    url: string,
    registry: string,
    options?: RegistryRequestOptions,
  ): Promise<unknown>
  /** What this client has received so far, per `url.host`: copies, so a snapshot stays as it was. */
  stats(): Record<string, RegistryHostStats>
  destroy(): void
}

export interface RegistryHostStats {
  /** Every response, whatever its status. */
  responses: number
  /** Bytes of 2xx bodies as received (gzip bytes when compressed). */
  bodyBytes: number
  /** The same bodies after gunzip. */
  decodedBytes: number
}

export interface RegistryClientOptions {
  /** Default: `setTimeout` from `timers/promises`; tests record the delays. */
  sleep?: (ms: number) => Promise<void>
  /** Test seam: resolve test hostnames to 127.0.0.1. */
  lookup?: net.LookupFunction
}

/** A failed request. Never carries header values or URL userinfo. */
export class RegistryRequestError extends Error {
  code?: string
  status?: number

  constructor(
    message: string,
    details: { code?: string; status?: number } = {},
  ) {
    super(message)
    this.name = 'RegistryRequestError'
    this.code = details.code
    this.status = details.status
  }
}

const MAX_REDIRECTS = 5

/** `Age` is a count of seconds; anything else is ignored. */
const ageOf = (value: string | undefined): number | undefined =>
  value !== undefined && /^\d{1,10}$/.test(value.trim())
    ? Number(value.trim())
    : undefined

const USER_AGENT = `always-up-to-date/${packageJson.version} node/${process.version} ${process.platform} ${process.arch}`

type Outcome = { authenticated: boolean } & (
  | {
      kind: 'json'
      value: unknown
      etag?: string
      cacheControl?: string
      age?: number
    }
  | {
      kind: 'not-modified'
      etag?: string
      cacheControl?: string
      age?: number
    }
  | { kind: 'redirect'; location: string }
  | { kind: 'status'; status: number; message: string; retryAfter?: string }
)

// Node throws ERR_INVALID_CHAR on a header value outside printable ASCII, and
// a validator that long is no validator: drop it and the entry is TTL-only.
const usableEtag = (value: string | undefined): string | undefined =>
  value !== undefined &&
  value.length <= 1024 &&
  /^[\x21-\x7e][\x20-\x7e]*$/.test(value)
    ? value
    : undefined

const basicFromUserinfo = (url: URL): string | undefined =>
  url.username || url.password
    ? `Basic ${Buffer.from(`${decodeUri(url.username)}:${decodeUri(url.password)}`).toString('base64')}`
    : undefined

/** The URL without userinfo or query: safe to put in an error or a log line. */
const redact = (url: URL): string => `${url.origin}${url.pathname}`

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' &&
  error !== null &&
  'code' in error &&
  typeof error.code === 'string'
    ? error.code
    : undefined

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

const headerValue = (
  value: string | string[] | undefined,
): string | undefined => (Array.isArray(value) ? value[0] : value)

const readBody = async (
  res: http.IncomingMessage,
): Promise<{ body: Buffer; received: number }> => {
  const chunks: Buffer[] = []
  let received = 0
  const encoding = headerValue(res.headers['content-encoding'])?.toLowerCase()
  if (encoding && encoding !== 'gzip' && encoding !== 'identity') {
    res.resume()
    throw new RegistryRequestError(`unsupported content-encoding ${encoding}`)
  }
  await pipeline(
    res,
    async function* count(source: AsyncIterable<Buffer>) {
      for await (const chunk of source) {
        received += chunk.length
        yield chunk
      }
    },
    ...(encoding === 'gzip' ? [zlib.createGunzip()] : []),
    async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) chunks.push(chunk)
    },
  )
  return { body: Buffer.concat(chunks), received }
}

/** The client certificate and key, or nothing (with a debug line) when either cannot be read. */
const clientCertificate = (
  url: URL,
  certfile: string | undefined,
  keyfile: string | undefined,
): { cert?: string; key?: string } => {
  if (!certfile || !keyfile) return {}
  try {
    return {
      cert: fs.readFileSync(certfile, 'utf8'),
      key: fs.readFileSync(keyfile, 'utf8'),
    }
  } catch (error) {
    logger.debug(
      `Skipping the client certificate for ${url.host}: ${codeOf(error) ?? 'unreadable'}`,
    )
    return {}
  }
}

export const createRegistryClient = (
  config: RegistryConfig,
  options: RegistryClientOptions = {},
): RegistryClient => {
  const sleep =
    options.sleep ??
    (async (ms: number) => {
      await sleepFor(ms)
    })
  const agents = new Map<string, http.Agent>()
  const hostStats = new Map<string, RegistryHostStats>()

  const statsFor = (url: URL): RegistryHostStats => {
    let stats = hostStats.get(url.host)
    if (!stats) {
      stats = { responses: 0, bodyBytes: 0, decodedBytes: 0 }
      hostStats.set(url.host, stats)
    }
    return stats
  }

  const agentFor = (
    url: URL,
    credentials: RegistryCredentials | undefined,
  ): http.Agent => {
    const certfile = credentials?.certfile
    const keyfile = credentials?.keyfile
    const key = `${url.protocol}//${url.host} ${certfile ?? ''} ${keyfile ?? ''}`
    const existing = agents.get(key)
    if (existing) return existing

    const base = {
      keepAlive: true,
      maxSockets: config.maxSockets,
      ...(options.lookup ? { lookup: options.lookup } : {}),
      ...(config.proxy.HTTPS_PROXY || config.proxy.HTTP_PROXY
        ? { proxyEnv: config.proxy }
        : {}),
    }
    const agent =
      url.protocol === 'https:'
        ? new https.Agent({
            ...base,
            rejectUnauthorized: config.strictSSL,
            ...(config.ca ? { ca: config.ca } : {}),
            ...clientCertificate(url, certfile, keyfile),
          })
        : new http.Agent(base)
    agents.set(key, agent)
    return agent
  }

  const once = async (
    target: URL,
    registry: string,
    callerSignals: AbortSignal[],
    accept: string,
    timeoutMs: number,
    ifNoneMatch: string | undefined,
  ): Promise<Outcome> => {
    const url = new URL(target)
    // npm sends userinfo in the URL as Basic auth, unless .npmrc scopes
    // credentials to the prefix. It is never sent in the URL, logged or thrown.
    const userinfo = basicFromUserinfo(url)
    url.username = ''
    url.password = ''
    const credentials = credentialsFor(url, registry, config.credentials)
    const authorization = authorizationFor(credentials) ?? userinfo
    const authenticated =
      Boolean(authorization) ||
      Boolean(credentials?.certfile && credentials?.keyfile)
    const timeout = AbortSignal.timeout(timeoutMs)
    const signal = AbortSignal.any([timeout, ...callerSignals])

    try {
      const response = await new Promise<http.IncomingMessage>(
        (resolve, reject) => {
          const request = (url.protocol === 'https:' ? https : http).request(
            url,
            {
              agent: agentFor(url, credentials),
              signal,
              headers: {
                accept,
                'accept-encoding': 'gzip',
                'user-agent': USER_AGENT,
                ...(authorization ? { authorization } : {}),
                ...(ifNoneMatch ? { 'if-none-match': ifNoneMatch } : {}),
              },
            },
            resolve,
          )
          request.on('error', reject)
          request.end()
        },
      )

      const status = response.statusCode ?? 0
      const stats = statsFor(url)
      stats.responses++
      const etag = usableEtag(headerValue(response.headers.etag))
      const cacheControl = headerValue(response.headers['cache-control'])
      const age = ageOf(headerValue(response.headers.age))
      if (status === 304 && ifNoneMatch) {
        response.resume()
        return { kind: 'not-modified', etag, cacheControl, age, authenticated }
      }
      if (status >= 200 && status < 300) {
        const { body, received } = await readBody(response)
        stats.bodyBytes += received
        stats.decodedBytes += body.length
        try {
          return {
            kind: 'json',
            value: JSON.parse(body.toString('utf8')),
            etag,
            cacheControl,
            age,
            authenticated,
          }
        } catch {
          throw new RegistryRequestError(
            `GET ${redact(url)}: response is not valid JSON`,
          )
        }
      }
      response.resume()
      const location = headerValue(response.headers.location)
      if (status >= 300 && status < 400 && location) {
        return { kind: 'redirect', location, authenticated }
      }
      return {
        kind: 'status',
        status,
        message: response.statusMessage ?? '',
        retryAfter: headerValue(response.headers['retry-after']),
        authenticated,
      }
    } catch (error) {
      if (timeout.aborted && !callerSignals.some((s) => s.aborted)) {
        throw new RegistryRequestError(
          `GET ${redact(url)}: timed out after ${timeoutMs}ms`,
          { code: 'ETIMEDOUT' },
        )
      }
      if (error instanceof RegistryRequestError) throw error
      throw new RegistryRequestError(
        `GET ${redact(url)}: ${messageOf(error)}`,
        { code: codeOf(error) },
      )
    }
  }

  const getResponse = async (
    url: string,
    registry: string,
    requestOptions: RegistryRequestOptions & { ifNoneMatch?: string } = {},
  ): Promise<RegistryResponse> => {
    const accept = requestOptions.accept ?? 'application/json'
    const timeoutMs = requestOptions.timeout ?? config.fetchTimeout
    const retries = requestOptions.retries ?? config.fetchRetries
    const callerSignals = requestOptions.signal ? [requestOptions.signal] : []
    let target = new URL(url)
    let redirects = 0
    let authenticated = false

    for (let attempt = 0; ; ) {
      let outcome: Outcome
      try {
        outcome = await once(
          target,
          registry,
          callerSignals,
          accept,
          timeoutMs,
          requestOptions.ifNoneMatch,
        )
      } catch (error) {
        if (attempt < retries && isRetryableError(error)) {
          await sleep(retryDelay(attempt, undefined, Date.now()) ?? 0)
          attempt++
          continue
        }
        throw error
      }

      authenticated ||= outcome.authenticated

      if (outcome.kind === 'json') {
        return {
          notModified: false,
          body: outcome.value,
          etag: outcome.etag,
          cacheControl: outcome.cacheControl,
          age: outcome.age,
          authenticated,
        }
      }

      if (outcome.kind === 'not-modified') {
        return {
          notModified: true,
          etag: outcome.etag,
          cacheControl: outcome.cacheControl,
          age: outcome.age,
          authenticated,
        }
      }

      if (outcome.kind === 'redirect') {
        let next: URL
        try {
          next = new URL(outcome.location, target)
        } catch {
          throw new RegistryRequestError(
            `GET ${redact(target)}: redirect to an invalid location`,
          )
        }
        if (++redirects > MAX_REDIRECTS) {
          throw new RegistryRequestError(
            `GET ${redact(target)}: too many redirects`,
          )
        }
        if (target.protocol === 'https:' && next.protocol !== 'https:') {
          throw new RegistryRequestError(
            `GET ${redact(target)}: refused redirect from https to ${redact(next)}`,
          )
        }
        target = next
        continue
      }

      if (attempt < retries && isRetryableStatus(outcome.status)) {
        const delay = retryDelay(attempt, outcome.retryAfter, Date.now())
        if (delay !== undefined) {
          await sleep(delay)
          attempt++
          continue
        }
      }
      throw new RegistryRequestError(
        `GET ${redact(target)}: ${outcome.status} ${outcome.message}`.trim(),
        { status: outcome.status },
      )
    }
  }

  const getJson = async (
    url: string,
    registry: string,
    requestOptions: RegistryRequestOptions = {},
  ): Promise<unknown> => {
    const response = await getResponse(url, registry, requestOptions)
    // Unreachable: a 304 is returned only for a request with ifNoneMatch.
    if (response.notModified) {
      throw new RegistryRequestError('unexpected 304 response')
    }
    return response.body
  }

  return {
    getResponse,
    getJson,
    stats: () =>
      Object.fromEntries(
        [...hostStats].map(([host, stats]) => [host, { ...stats }]),
      ),
    destroy: () => {
      for (const agent of agents.values()) agent.destroy()
      agents.clear()
    },
  }
}
