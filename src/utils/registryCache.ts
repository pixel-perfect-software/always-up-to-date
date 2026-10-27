import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import zlib from 'zlib'
import type { RegistryVersion } from '@/types'
import logger from './logger'
import type { NpmrcSources } from './npmrcLoader'
import type { ParsedPackument } from './registryDocuments'
import { parseCacheControl } from './registryRequest'

export const CACHE_FOLDER = 'ca.pixel-perfect.alwaysuptodate'
export const DEFAULT_MAX_BYTES = 32 * 1024 * 1024

export const TTL_SECONDS = {
  'dist-tags': 300,
  'deps.dev': 3600,
  packument: 300,
  'packument-full': 300,
} as const

export type CacheKind = keyof typeof TTL_SECONDS

export interface CacheValues {
  'dist-tags': { latest: string }
  'deps.dev': RegistryVersion[]
  packument: ParsedPackument
  'packument-full': ParsedPackument
}

export interface CachedEntry<K extends CacheKind> {
  value: CacheValues[K]
  etag?: string
  fresh: boolean
}

export interface ResponseMeta {
  cacheControl?: string
  etag?: string
  authenticated: boolean
}

export interface CacheStats {
  fresh: number
  stale: number
  missing: number
  written: number
  failedWrites: number
  pruned: number
}

export interface RegistryCache {
  readonly dir: string
  /** A hit touches the file's mtime, which is the LRU order. */
  get<K extends CacheKind>(
    kind: K,
    endpoint: string,
    name: string,
  ): CachedEntry<K> | undefined
  /** False when nothing was stored: not storable, or the write failed. */
  put<K extends CacheKind>(
    kind: K,
    endpoint: string,
    name: string,
    value: CacheValues[K],
    meta: ResponseMeta,
    options?: { sameForEveryone?: boolean },
  ): boolean
  stats(): CacheStats
  /** Prunes when this run grew the folder. Safe to call twice. */
  close(): void
}

const SCHEMA = 1
const VERSION_FOLDER = `v${SCHEMA}`
const BLOCK_BYTES = 4096
const PRUNE_TARGET = 0.8
const STALE_TMP_MS = 60 * 60 * 1000
const ENTRY_FILE = /^[0-9a-f]{64}\.json\.gz$/
const CACHEDIR_TAG = [
  'Signature: 8a477f597d28d172789f06886806bc55',
  '# This file is a cache directory tag created by always-up-to-date.',
  '# For information about cache directory tags, see https://bford.info/cachedir/',
  '',
].join('\n')

const KINDS = Object.keys(TTL_SECONDS) as CacheKind[]

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const nonEmpty = (value: string | undefined): string | undefined =>
  value ? value : undefined

/**
 * Where the cache lives: `AUTD_CACHE_DIR` (against `cwd`), else the
 * platform's cache folder. Undefined when there is no home to anchor it.
 */
export const cacheDirectory = (
  cwd: string,
  sources: Pick<NpmrcSources, 'env' | 'home' | 'platform'>,
): string | undefined => {
  const { env, home, platform } = sources
  const override = nonEmpty(env.AUTD_CACHE_DIR)
  if (override) return path.resolve(cwd, override)
  if (!home) return undefined
  if (platform === 'darwin')
    return path.posix.join(home, 'Library', 'Caches', CACHE_FOLDER)
  if (platform === 'win32')
    return path.win32.join(
      nonEmpty(env.LOCALAPPDATA) ?? path.win32.join(home, 'AppData', 'Local'),
      CACHE_FOLDER,
    )
  const xdg = nonEmpty(env.XDG_CACHE_HOME)
  return path.posix.join(
    xdg && path.posix.isAbsolute(xdg) ? xdg : path.posix.join(home, '.cache'),
    CACHE_FOLDER,
  )
}

/** `protocol//host/path/`: no userinfo, query or hash, and always a trailing slash. */
export const endpointKey = (url: string): string => {
  const { protocol, host, pathname } = new URL(url)
  return `${protocol}//${host}${pathname.endsWith('/') ? pathname : `${pathname}/`}`
}

/**
 * Seconds an answer may be served without asking again. 0 means only after
 * the registry confirms it with a 304, so it needs an ETag; undefined means
 * don't store it. An authenticated or private answer is served unasked only
 * if it is the same for everyone (RFC 9111 §3.5).
 */
export const freshFor = (
  kind: CacheKind,
  meta: ResponseMeta,
  sameForEveryone = false,
): number | undefined => {
  const directives = parseCacheControl(meta.cacheControl)
  if (directives.noStore) return undefined
  const revalidateOnly = meta.etag ? 0 : undefined
  if (
    (meta.authenticated || directives.isPrivate) &&
    !(directives.isPublic || sameForEveryone)
  )
    return revalidateOnly
  if (directives.noCache || directives.maxAge === 0) return revalidateOnly
  return Math.min(
    TTL_SECONDS[kind],
    directives.maxAge ?? Number.POSITIVE_INFINITY,
  )
}

const isVersion = (value: unknown): boolean =>
  isRecord(value) &&
  typeof value.version === 'string' &&
  typeof value.deprecated === 'boolean' &&
  (value.deprecatedReason === undefined ||
    typeof value.deprecatedReason === 'string') &&
  (value.publishedAt === undefined || typeof value.publishedAt === 'string')

const isVersions = (value: unknown): boolean =>
  Array.isArray(value) && value.every(isVersion)

const validValue = (kind: CacheKind, value: unknown): boolean => {
  if (kind === 'deps.dev') return isVersions(value)
  if (!isRecord(value)) return false
  if (kind === 'dist-tags') return typeof value.latest === 'string'
  return (
    isVersions(value.versions) &&
    (value.latest === undefined || typeof value.latest === 'string')
  )
}

const blocks = (bytes: number): number => Math.ceil(bytes / BLOCK_BYTES)

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error)

export const createRegistryCache = (options: {
  dir: string
  now?: () => number
  maxBytes?: number
}): RegistryCache => {
  const { dir, now = Date.now, maxBytes = DEFAULT_MAX_BYTES } = options
  const root = path.join(dir, VERSION_FOLDER)
  const counts: CacheStats = {
    fresh: 0,
    stale: 0,
    missing: 0,
    written: 0,
    failedWrites: 0,
    pruned: 0,
  }
  let writable = true
  let tagged = false
  let grew = false
  let closed = false

  const fileFor = (kind: CacheKind, endpoint: string, name: string): string =>
    path.join(
      root,
      kind,
      `${crypto.createHash('sha256').update(`${endpoint}\n${name}`).digest('hex')}.json.gz`,
    )

  const touch = (file: string): void => {
    const seconds = now() / 1000
    fs.utimesSync(file, seconds, seconds)
  }

  const read = <K extends CacheKind>(
    kind: K,
    endpoint: string,
    name: string,
  ): CachedEntry<K> | undefined => {
    const file = fileFor(kind, endpoint, name)
    let entry: unknown
    try {
      entry = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString())
    } catch {
      return undefined
    }
    if (
      !isRecord(entry) ||
      entry.schema !== SCHEMA ||
      entry.kind !== kind ||
      entry.endpoint !== endpoint ||
      entry.name !== name ||
      typeof entry.storedAt !== 'number' ||
      typeof entry.ttl !== 'number' ||
      !Number.isFinite(entry.storedAt) ||
      !Number.isFinite(entry.ttl) ||
      (entry.etag !== undefined && typeof entry.etag !== 'string') ||
      !validValue(kind, entry.value)
    )
      return undefined
    try {
      touch(file)
    } catch {
      // A read-only folder still answers.
    }
    const age = now() - entry.storedAt
    return {
      value: entry.value as CacheValues[K],
      ...(entry.etag === undefined ? {} : { etag: entry.etag }),
      fresh: age >= 0 && age < entry.ttl * 1000,
    }
  }

  const prune = (): void => {
    const entries: { file: string; bytes: number; mtimeMs: number }[] = []
    const cutoff = now() - STALE_TMP_MS
    let total = 0
    for (const kind of KINDS) {
      const folder = path.join(root, kind)
      let names: fs.Dirent[]
      try {
        names = fs.readdirSync(folder, { withFileTypes: true })
      } catch {
        continue
      }
      for (const dirent of names) {
        const isEntry = ENTRY_FILE.test(dirent.name)
        if (!dirent.isFile() || !(isEntry || dirent.name.endsWith('.tmp')))
          continue
        const file = path.join(folder, dirent.name)
        try {
          const stat = fs.statSync(file)
          if (isEntry) {
            const bytes = blocks(stat.size) * BLOCK_BYTES
            total += bytes
            entries.push({ file, bytes, mtimeMs: stat.mtimeMs })
          } else if (stat.mtimeMs < cutoff) {
            fs.unlinkSync(file)
            counts.pruned++
          }
        } catch {
          // Another run got there first.
        }
      }
    }
    if (total <= maxBytes) return
    entries.sort((a, b) => a.mtimeMs - b.mtimeMs || (a.file < b.file ? -1 : 1))
    for (const entry of entries) {
      if (total <= maxBytes * PRUNE_TARGET) break
      try {
        fs.unlinkSync(entry.file)
        counts.pruned++
      } catch {
        // Gone already; its bytes are not counted either way.
      }
      total -= entry.bytes
    }
  }

  const ensureFolders = (kind: CacheKind): void => {
    fs.mkdirSync(path.join(root, kind), { recursive: true, mode: 0o700 })
    if (tagged) return
    tagged = true
    try {
      fs.writeFileSync(path.join(dir, 'CACHEDIR.TAG'), CACHEDIR_TAG, {
        flag: 'wx',
        mode: 0o600,
      })
    } catch {
      // Already there, or not worth failing a write for.
    }
  }

  const failWrite = (message: string): false => {
    counts.failedWrites++
    logger.debug(message)
    return false
  }

  return {
    dir,
    get(kind, endpoint, name) {
      let entry: CachedEntry<typeof kind> | undefined
      try {
        entry = read(kind, endpointKey(endpoint), name)
      } catch {
        entry = undefined
      }
      if (!entry) counts.missing++
      else if (entry.fresh) counts.fresh++
      else counts.stale++
      return entry
    },
    put(kind, endpoint, name, value, meta, putOptions) {
      const ttl = freshFor(kind, meta, putOptions?.sameForEveryone)
      if (ttl === undefined) return false
      if (!writable) {
        counts.failedWrites++
        return false
      }
      let tmp: string | undefined
      try {
        const key = endpointKey(endpoint)
        const file = fileFor(kind, key, name)
        const storedAt = now()
        const data = zlib.gzipSync(
          JSON.stringify({
            schema: SCHEMA,
            kind,
            endpoint: key,
            name,
            storedAt,
            ttl,
            ...(meta.etag === undefined ? {} : { etag: meta.etag }),
            value,
          }),
        )
        try {
          ensureFolders(kind)
          tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`
          fs.writeFileSync(tmp, data, { flag: 'wx', mode: 0o600 })
          touch(tmp)
        } catch (error) {
          writable = false
          if (tmp) fs.rmSync(tmp, { force: true })
          return failWrite(
            `registry cache: cannot write to ${dir}: ${errorMessage(error)}`,
          )
        }
        let before = 0
        try {
          before = blocks(fs.statSync(file).size)
        } catch {
          // A new entry.
        }
        try {
          fs.renameSync(tmp, file)
        } catch (error) {
          fs.rmSync(tmp, { force: true })
          return failWrite(
            `registry cache: kept the old ${kind} entry for ${name}: ${errorMessage(error)}`,
          )
        }
        if (blocks(data.length) > before) grew = true
        counts.written++
        return true
      } catch (error) {
        return failWrite(
          `registry cache: cannot store ${kind} for ${name}: ${errorMessage(error)}`,
        )
      }
    },
    stats: () => ({ ...counts }),
    close() {
      if (closed) return
      closed = true
      if (!grew) return
      try {
        prune()
      } catch (error) {
        logger.debug(`registry cache: pruning failed: ${errorMessage(error)}`)
      }
    },
  }
}
