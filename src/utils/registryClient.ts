import fs from 'fs'
import http from 'http'
import https from 'https'
import type net from 'net'
import { pipeline } from 'stream/promises'
import { setTimeout as sleepFor } from 'timers/promises'
import zlib from 'zlib'
import type { RegistryConfig, RegistryCredentials } from '@/types'
import packageJson from '../../package.json'
import {
  authorizationFor,
  credentialsFor,
  isRetryableError,
  isRetryableStatus,
  retryDelay,
} from './registryRequest'

export interface RegistryClient {
  /** GET url as JSON with the credentials and agent for its registry; rejects with RegistryRequestError. */
  getJson(
    url: string,
    registry: string,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>
  destroy(): void
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

const USER_AGENT = `always-up-to-date/${packageJson.version} node/${process.version} ${process.platform} ${process.arch}`

type Outcome =
  | { kind: 'json'; value: unknown }
  | { kind: 'redirect'; location: string }
  | { kind: 'status'; status: number; message: string; retryAfter?: string }

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

const readBody = async (res: http.IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = []
  const encoding = headerValue(res.headers['content-encoding'])?.toLowerCase()
  if (encoding && encoding !== 'gzip' && encoding !== 'identity') {
    res.resume()
    throw new RegistryRequestError(`unsupported content-encoding ${encoding}`)
  }
  await pipeline(
    res,
    ...(encoding === 'gzip' ? [zlib.createGunzip()] : []),
    async (source: AsyncIterable<Buffer>) => {
      for await (const chunk of source) chunks.push(chunk)
    },
  )
  return Buffer.concat(chunks)
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
            ...(certfile && keyfile
              ? {
                  cert: fs.readFileSync(certfile, 'utf8'),
                  key: fs.readFileSync(keyfile, 'utf8'),
                }
              : {}),
          })
        : new http.Agent(base)
    agents.set(key, agent)
    return agent
  }

  const once = async (
    target: URL,
    registry: string,
    callerSignals: AbortSignal[],
  ): Promise<Outcome> => {
    const url = new URL(target)
    url.username = ''
    url.password = ''
    const credentials = credentialsFor(url, registry, config.credentials)
    const authorization = authorizationFor(credentials)
    const timeout = AbortSignal.timeout(config.fetchTimeout)
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
                accept: 'application/json',
                'accept-encoding': 'gzip',
                'user-agent': USER_AGENT,
                ...(authorization ? { authorization } : {}),
              },
            },
            resolve,
          )
          request.on('error', reject)
          request.end()
        },
      )

      const status = response.statusCode ?? 0
      if (status >= 200 && status < 300) {
        const body = await readBody(response)
        try {
          return { kind: 'json', value: JSON.parse(body.toString('utf8')) }
        } catch {
          throw new RegistryRequestError(
            `GET ${redact(url)}: response is not valid JSON`,
          )
        }
      }
      response.resume()
      const location = headerValue(response.headers.location)
      if (status >= 300 && status < 400 && location) {
        return { kind: 'redirect', location }
      }
      return {
        kind: 'status',
        status,
        message: response.statusMessage ?? '',
        retryAfter: headerValue(response.headers['retry-after']),
      }
    } catch (error) {
      if (timeout.aborted && !callerSignals.some((s) => s.aborted)) {
        throw new RegistryRequestError(
          `GET ${redact(url)}: timed out after ${config.fetchTimeout}ms`,
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

  const getJson = async (
    url: string,
    registry: string,
    requestOptions: { signal?: AbortSignal } = {},
  ): Promise<unknown> => {
    const callerSignals = requestOptions.signal ? [requestOptions.signal] : []
    let target = new URL(url)
    let redirects = 0

    for (let attempt = 0; ; ) {
      let outcome: Outcome
      try {
        outcome = await once(target, registry, callerSignals)
      } catch (error) {
        if (attempt < config.fetchRetries && isRetryableError(error)) {
          await sleep(retryDelay(attempt, undefined, Date.now()) ?? 0)
          attempt++
          continue
        }
        throw error
      }

      if (outcome.kind === 'json') return outcome.value

      if (outcome.kind === 'redirect') {
        const next = new URL(outcome.location, target)
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

      if (attempt < config.fetchRetries && isRetryableStatus(outcome.status)) {
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

  return {
    getJson,
    destroy: () => {
      for (const agent of agents.values()) agent.destroy()
      agents.clear()
    },
  }
}
