jest.mock('@/utils/logger')

import { spawn } from 'child_process'
import crypto from 'crypto'
import fs from 'fs'
import os from 'os'
import path from 'path'
import zlib from 'zlib'
import type { RegistryVersion } from '@/types'
import logger from '@/utils/logger'
import {
  type CacheKind,
  type CacheValues,
  cacheDirectory,
  createRegistryCache,
  endpointKey,
  freshFor,
  type RegistryCache,
  TTL_SECONDS,
} from '@/utils/registryCache'
import { parseDepsDevPackage } from '@/utils/registryDocuments'
import { registryBody } from '../fixtures/registry'

const REGISTRY = 'https://registry.npmjs.org/'
const POSIX = process.platform !== 'win32'
const T0 = 2_000_000_000_000

let tmp: string
let clock: number

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-cache-'))
  clock = T0
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const open = (
  options: { dir?: string; maxBytes?: number } = {},
): RegistryCache =>
  createRegistryCache({
    dir: options.dir ?? path.join(tmp, 'cache'),
    now: () => clock,
    ...(options.maxBytes === undefined ? {} : { maxBytes: options.maxBytes }),
  })

const PUBLIC = { cacheControl: 'public, max-age=300', authenticated: false }

const versions = (...list: string[]): RegistryVersion[] =>
  list.map((version) => ({ version, deprecated: false }))

/** An entry no gzip shrinks: about 6 KB on disk, so two 4 KiB blocks. */
const bulky = (seed: number): CacheValues['packument'] => ({
  latest: '1.0.0',
  versions: [
    {
      version: '1.0.0',
      deprecated: true,
      deprecatedReason: `${seed}:${crypto.randomBytes(6000).toString('hex')}`,
    },
  ],
})

const kindDir = (cache: RegistryCache, kind: CacheKind): string =>
  path.join(cache.dir, 'v1', kind)

const names = (folder: string): string[] =>
  fs.existsSync(folder) ? fs.readdirSync(folder).sort() : []

const entryFiles = (cache: RegistryCache, kind: CacheKind): string[] =>
  names(kindDir(cache, kind)).filter((name) => name.endsWith('.json.gz'))

const walk = (folder: string): string[] =>
  fs
    .readdirSync(folder, { withFileTypes: true })
    .flatMap((entry) =>
      entry.isDirectory()
        ? walk(path.join(folder, entry.name))
        : [path.join(folder, entry.name)],
    )

const sources = (
  platform: NodeJS.Platform,
  env: NodeJS.ProcessEnv,
  home = '/home/u',
) => ({ platform, env, home })

describe('cacheDirectory', () => {
  const id = 'ca.pixel-perfect.alwaysuptodate'

  it('uses ~/Library/Caches on macOS and ignores XDG_CACHE_HOME', () => {
    expect(
      cacheDirectory(
        tmp,
        sources('darwin', { XDG_CACHE_HOME: '/x' }, '/Users/u'),
      ),
    ).toBe(`/Users/u/Library/Caches/${id}`)
  })

  it('uses an absolute XDG_CACHE_HOME on Linux', () => {
    expect(
      cacheDirectory(tmp, sources('linux', { XDG_CACHE_HOME: '/var/xdg' })),
    ).toBe(`/var/xdg/${id}`)
  })

  it('falls back to ~/.cache for a relative or missing XDG_CACHE_HOME', () => {
    expect(
      cacheDirectory(tmp, sources('linux', { XDG_CACHE_HOME: 'rel/xdg' })),
    ).toBe(`/home/u/.cache/${id}`)
    expect(cacheDirectory(tmp, sources('linux', {}))).toBe(
      `/home/u/.cache/${id}`,
    )
    expect(cacheDirectory(tmp, sources('linux', { XDG_CACHE_HOME: '' }))).toBe(
      `/home/u/.cache/${id}`,
    )
  })

  it('uses LOCALAPPDATA on Windows, else <home>\\AppData\\Local', () => {
    expect(
      cacheDirectory(
        tmp,
        sources('win32', { LOCALAPPDATA: 'C:\\L' }, 'C:\\Users\\u'),
      ),
    ).toBe(`C:\\L\\${id}`)
    expect(cacheDirectory(tmp, sources('win32', {}, 'C:\\Users\\u'))).toBe(
      `C:\\Users\\u\\AppData\\Local\\${id}`,
    )
  })

  it('lets AUTD_CACHE_DIR win, resolved against cwd', () => {
    const absolute = path.join(tmp, 'abs')
    expect(
      cacheDirectory(tmp, sources('linux', { AUTD_CACHE_DIR: absolute })),
    ).toBe(absolute)
    expect(
      cacheDirectory(tmp, sources('darwin', { AUTD_CACHE_DIR: 'rel/dir' })),
    ).toBe(path.join(tmp, 'rel', 'dir'))
  })

  it('ignores an empty AUTD_CACHE_DIR', () => {
    expect(cacheDirectory(tmp, sources('linux', { AUTD_CACHE_DIR: '' }))).toBe(
      `/home/u/.cache/${id}`,
    )
  })

  it('has no folder without a home', () => {
    for (const platform of ['darwin', 'linux', 'win32'] as const)
      expect(cacheDirectory(tmp, sources(platform, {}, ''))).toBeUndefined()
  })

  it('still honors AUTD_CACHE_DIR without a home', () => {
    const dir = path.join(tmp, 'there')
    expect(
      cacheDirectory(tmp, sources('linux', { AUTD_CACHE_DIR: dir }, '')),
    ).toBe(dir)
  })
})

describe('endpointKey', () => {
  it('drops userinfo, query and hash', () => {
    expect(endpointKey('https://u:p@host.example:8443/a/b/?x=1#h')).toBe(
      'https://host.example:8443/a/b/',
    )
  })

  it('adds the trailing slash', () => {
    expect(endpointKey('https://registry.npmjs.org')).toBe(REGISTRY)
    expect(endpointKey('https://registry.npmjs.org')).toBe(
      endpointKey('https://registry.npmjs.org/'),
    )
    expect(endpointKey('https://host/prefix')).toBe('https://host/prefix/')
  })
})

describe('freshFor', () => {
  const plain = { authenticated: false }
  const etag = '"abc"'

  it('stores nothing for no-store, whatever else is said', () => {
    expect(
      freshFor('packument', { ...plain, cacheControl: 'no-store', etag }),
    ).toBeUndefined()
    expect(
      freshFor('packument', {
        authenticated: true,
        cacheControl: 'public, no-store',
        etag,
      }),
    ).toBeUndefined()
  })

  it('serves an unauthenticated answer for the kind default', () => {
    for (const kind of Object.keys(TTL_SECONDS) as CacheKind[])
      expect(freshFor(kind, plain)).toBe(TTL_SECONDS[kind])
  })

  it('lowers the default with a smaller max-age and never raises it', () => {
    expect(
      freshFor('dist-tags', { ...plain, cacheControl: 'max-age=60' }),
    ).toBe(60)
    expect(
      freshFor('dist-tags', { ...plain, cacheControl: 'max-age=99999' }),
    ).toBe(300)
    expect(
      freshFor('deps.dev', { ...plain, cacheControl: 'public, max-age=3600' }),
    ).toBe(3600)
  })

  it('revalidates only, with an ETag, on no-cache and max-age=0', () => {
    for (const cacheControl of ['no-cache', 'max-age=0', 'public, max-age=0']) {
      expect(freshFor('packument', { ...plain, cacheControl, etag })).toBe(0)
      expect(freshFor('packument', { ...plain, cacheControl })).toBeUndefined()
    }
  })

  it('revalidates only an authenticated answer that is not public', () => {
    expect(freshFor('packument', { authenticated: true, etag })).toBe(0)
    expect(
      freshFor('packument', {
        authenticated: true,
        cacheControl: 'max-age=300',
      }),
    ).toBeUndefined()
    expect(
      freshFor('packument', {
        authenticated: true,
        cacheControl: 'max-age=300',
        etag,
      }),
    ).toBe(0)
  })

  it('treats private as authenticated', () => {
    expect(
      freshFor('packument', { ...plain, cacheControl: 'private', etag }),
    ).toBe(0)
    expect(
      freshFor('packument', { ...plain, cacheControl: 'private' }),
    ).toBeUndefined()
  })

  it('does not let public make an authenticated answer reusable (a private registry may say it too)', () => {
    const meta = {
      authenticated: true,
      cacheControl: 'public, max-age=300',
    }
    expect(freshFor('packument', meta)).toBeUndefined()
    expect(freshFor('packument', { ...meta, etag })).toBe(0)
  })

  it('keeps an unauthenticated public answer for the default', () => {
    expect(
      freshFor('packument', {
        authenticated: false,
        cacheControl: 'public, max-age=300',
      }),
    ).toBe(300)
  })

  it('revalidates private even when the same for everyone', () => {
    expect(
      freshFor(
        'dist-tags',
        { authenticated: true, cacheControl: 'private', etag },
        true,
      ),
    ).toBe(0)
    expect(
      freshFor(
        'dist-tags',
        { authenticated: true, cacheControl: 'private' },
        true,
      ),
    ).toBeUndefined()
  })

  it('takes Age off the freshness, and revalidates when it is used up', () => {
    expect(freshFor('packument', { ...plain, age: 100 })).toBe(200)
    expect(
      freshFor('packument', { ...plain, cacheControl: 'max-age=60', age: 45 }),
    ).toBe(15)
    expect(freshFor('packument', { ...plain, age: 300 })).toBeUndefined()
    expect(freshFor('packument', { ...plain, age: 9999, etag })).toBe(0)
    expect(freshFor('packument', { ...plain, age: 0 })).toBe(300)
  })

  it('serves an authenticated answer unasked when the same for everyone', () => {
    expect(freshFor('dist-tags', { authenticated: true }, true)).toBe(300)
    expect(
      freshFor('dist-tags', { authenticated: true }, false),
    ).toBeUndefined()
    expect(
      freshFor(
        'dist-tags',
        { authenticated: true, cacheControl: 'max-age=60' },
        true,
      ),
    ).toBe(60)
  })

  it('still revalidates a shared answer that says no-cache', () => {
    expect(
      freshFor(
        'dist-tags',
        { authenticated: true, cacheControl: 'no-cache', etag },
        true,
      ),
    ).toBe(0)
  })
})

describe('round trips', () => {
  const next = parseDepsDevPackage(JSON.parse(registryBody('next.deps-dev')))

  const cases: { [K in CacheKind]: [string, CacheValues[K]] } = {
    'dist-tags': [REGISTRY, { latest: '1.2.3' }],
    'deps.dev': ['https://api.deps.dev/v3/', next ?? []],
    packument: [
      REGISTRY,
      {
        latest: '2.0.0',
        versions: [
          { version: '1.0.0', deprecated: true, deprecatedReason: 'old' },
          {
            version: '2.0.0',
            deprecated: false,
            publishedAt: '2026-01-02T03:04:05.000Z',
          },
        ],
      },
    ],
    'packument-full': [REGISTRY, { versions: versions('1.0.0') }],
  }

  it.each(Object.keys(cases) as CacheKind[])(
    'returns a %s value equal',
    (kind) => {
      const cache = open()
      const [endpoint, value] = cases[kind]
      expect(cache.put(kind, endpoint, 'pkg', value as never, PUBLIC)).toBe(
        true,
      )
      expect(cache.get(kind, endpoint, 'pkg')).toEqual({
        value,
        cacheControl: PUBLIC.cacheControl,
        authenticated: false,
        fresh: true,
      })
    },
  )

  it('answers with the real deps.dev capture', () => {
    expect(next?.length).toBeGreaterThan(100)
  })

  it('is fresh at ttl - 1 ms and stale at ttl', () => {
    const cache = open()
    cache.put('dist-tags', REGISTRY, 'pkg', { latest: '1.0.0' }, PUBLIC)
    clock = T0 + 299_999
    expect(cache.get('dist-tags', REGISTRY, 'pkg')?.fresh).toBe(true)
    clock = T0 + 300_000
    expect(cache.get('dist-tags', REGISTRY, 'pkg')?.fresh).toBe(false)
  })

  it('uses the smaller max-age for the ttl', () => {
    const cache = open()
    cache.put(
      'dist-tags',
      REGISTRY,
      'pkg',
      { latest: '1.0.0' },
      { authenticated: false, cacheControl: 'max-age=60' },
    )
    clock = T0 + 60_000
    expect(cache.get('dist-tags', REGISTRY, 'pkg')?.fresh).toBe(false)
  })

  it('treats a storedAt in the future as stale', () => {
    const cache = open()
    clock = T0 + 10_000
    cache.put('dist-tags', REGISTRY, 'pkg', { latest: '1.0.0' }, PUBLIC)
    clock = T0
    expect(cache.get('dist-tags', REGISTRY, 'pkg')?.fresh).toBe(false)
  })

  it('returns a stale entry with its etag', () => {
    const cache = open()
    cache.put(
      'packument',
      REGISTRY,
      'pkg',
      { versions: versions('1.0.0') },
      { ...PUBLIC, etag: 'W/"v1"' },
    )
    clock = T0 + 301_000
    expect(cache.get('packument', REGISTRY, 'pkg')).toEqual({
      value: { versions: versions('1.0.0') },
      etag: 'W/"v1"',
      cacheControl: PUBLIC.cacheControl,
      authenticated: false,
      fresh: false,
    })
  })

  it('keeps an etag-only entry that is never fresh', () => {
    const cache = open()
    expect(
      cache.put(
        'packument',
        REGISTRY,
        'pkg',
        { versions: [] },
        { authenticated: true, etag: '"e"' },
      ),
    ).toBe(true)
    expect(cache.get('packument', REGISTRY, 'pkg')).toEqual({
      value: { versions: [] },
      etag: '"e"',
      authenticated: true,
      fresh: false,
    })
  })

  it('stores nothing it should not', () => {
    const cache = open()
    expect(
      cache.put(
        'dist-tags',
        REGISTRY,
        'pkg',
        { latest: '1.0.0' },
        { authenticated: true },
      ),
    ).toBe(false)
    expect(
      cache.put(
        'dist-tags',
        REGISTRY,
        'pkg',
        { latest: '1.0.0' },
        { authenticated: false, cacheControl: 'no-store' },
      ),
    ).toBe(false)
    expect(fs.existsSync(cache.dir)).toBe(false)
    expect(cache.stats().failedWrites).toBe(0)
  })

  it('stores a shared authenticated answer when told it is the same for everyone', () => {
    const cache = open()
    expect(
      cache.put(
        'dist-tags',
        REGISTRY,
        'pkg',
        { latest: '1.0.0' },
        { authenticated: true },
        { sameForEveryone: true },
      ),
    ).toBe(true)
    expect(cache.get('dist-tags', REGISTRY, 'pkg')?.fresh).toBe(true)
  })

  it('counts fresh, stale and missing lookups and writes', () => {
    const cache = open()
    cache.get('dist-tags', REGISTRY, 'pkg')
    cache.put('dist-tags', REGISTRY, 'pkg', { latest: '1.0.0' }, PUBLIC)
    cache.get('dist-tags', REGISTRY, 'pkg')
    clock += 400_000
    cache.get('dist-tags', REGISTRY, 'pkg')
    expect(cache.stats()).toEqual({
      fresh: 1,
      stale: 1,
      missing: 1,
      written: 1,
      failedWrites: 0,
      pruned: 0,
    })
  })

  it('treats an invalid endpoint as a miss and a failed write', () => {
    const cache = open()
    expect(cache.get('dist-tags', 'not a url', 'pkg')).toBeUndefined()
    expect(
      cache.put('dist-tags', 'not a url', 'pkg', { latest: '1.0.0' }, PUBLIC),
    ).toBe(false)
  })
})

describe('unreadable entries are misses', () => {
  const stored = (): { cache: RegistryCache; file: string } => {
    const cache = open()
    cache.put(
      'packument',
      REGISTRY,
      'pkg',
      { latest: '1.0.0', versions: versions('1.0.0') },
      PUBLIC,
    )
    const [name] = entryFiles(cache, 'packument')
    return { cache, file: path.join(kindDir(cache, 'packument'), name ?? '') }
  }
  const rewrite = (
    file: string,
    change: (entry: Record<string, unknown>) => void,
  ) => {
    const entry = JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString())
    change(entry)
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(entry)))
  }

  it('starts from a valid entry', () => {
    const { cache } = stored()
    expect(cache.get('packument', REGISTRY, 'pkg')?.fresh).toBe(true)
  })

  it('misses a truncated gzip', () => {
    const { cache, file } = stored()
    const data = fs.readFileSync(file)
    fs.writeFileSync(file, data.subarray(0, Math.floor(data.length / 2)))
    expect(cache.get('packument', REGISTRY, 'pkg')).toBeUndefined()
  })

  it('misses a file that is not gzip', () => {
    const { cache, file } = stored()
    fs.writeFileSync(file, '{"schema":1}')
    expect(cache.get('packument', REGISTRY, 'pkg')).toBeUndefined()
  })

  it('misses gzip that is not JSON', () => {
    const { cache, file } = stored()
    fs.writeFileSync(file, zlib.gzipSync('not json'))
    expect(cache.get('packument', REGISTRY, 'pkg')).toBeUndefined()
  })

  it('misses an empty file', () => {
    const { cache, file } = stored()
    fs.writeFileSync(file, '')
    expect(cache.get('packument', REGISTRY, 'pkg')).toBeUndefined()
  })

  it.each([
    [
      'schema 2',
      (entry: Record<string, unknown>) => {
        entry.schema = 2
      },
    ],
    [
      'a mismatched name',
      (entry: Record<string, unknown>) => {
        entry.name = 'other'
      },
    ],
    [
      'a mismatched key (another registry)',
      (entry: Record<string, unknown>) => {
        entry.key = 'f'.repeat(64)
      },
    ],
    [
      'a non-string cacheControl',
      (entry: Record<string, unknown>) => {
        entry.cacheControl = 5
      },
    ],
    [
      'a non-boolean authenticated',
      (entry: Record<string, unknown>) => {
        entry.authenticated = 'yes'
      },
    ],
    [
      'a mismatched kind',
      (entry: Record<string, unknown>) => {
        entry.kind = 'dist-tags'
      },
    ],
    [
      'a missing storedAt',
      (entry: Record<string, unknown>) => {
        delete entry.storedAt
      },
    ],
    [
      'a non-string etag',
      (entry: Record<string, unknown>) => {
        entry.etag = 5
      },
    ],
    [
      'an array value',
      (entry: Record<string, unknown>) => {
        entry.value = []
      },
    ],
    [
      'a version missing deprecated',
      (entry: Record<string, unknown>) => {
        entry.value = { versions: [{ version: '1.0.0' }] }
      },
    ],
  ])('misses %s', (_label, change) => {
    const { cache, file } = stored()
    rewrite(file, change)
    expect(cache.get('packument', REGISTRY, 'pkg')).toBeUndefined()
  })

  it('misses a deps.dev value that is not an array', () => {
    const cache = open()
    cache.put(
      'deps.dev',
      'https://api.deps.dev/v3/',
      'pkg',
      versions('1.0.0'),
      PUBLIC,
    )
    const [name] = entryFiles(cache, 'deps.dev')
    rewrite(path.join(kindDir(cache, 'deps.dev'), name ?? ''), (entry) => {
      entry.value = { versions: [] }
    })
    expect(
      cache.get('deps.dev', 'https://api.deps.dev/v3/', 'pkg'),
    ).toBeUndefined()
  })

  it('misses a dist-tags value without latest', () => {
    const cache = open()
    cache.put('dist-tags', REGISTRY, 'pkg', { latest: '1.0.0' }, PUBLIC)
    const [name] = entryFiles(cache, 'dist-tags')
    rewrite(path.join(kindDir(cache, 'dist-tags'), name ?? ''), (entry) => {
      entry.value = {}
    })
    expect(cache.get('dist-tags', REGISTRY, 'pkg')).toBeUndefined()
  })

  it('misses an entry path that is a directory', () => {
    const { cache, file } = stored()
    fs.rmSync(file)
    fs.mkdirSync(file)
    expect(cache.get('packument', REGISTRY, 'pkg')).toBeUndefined()
  })
})

describe('separation', () => {
  it('gives two registries with the same name two files', () => {
    const cache = open()
    cache.put('dist-tags', REGISTRY, 'pkg', { latest: '1.0.0' }, PUBLIC)
    cache.put(
      'dist-tags',
      'https://other.example/npm/',
      'pkg',
      { latest: '2.0.0' },
      PUBLIC,
    )
    expect(entryFiles(cache, 'dist-tags')).toHaveLength(2)
    expect(cache.get('dist-tags', REGISTRY, 'pkg')?.value).toEqual({
      latest: '1.0.0',
    })
    expect(
      cache.get('dist-tags', 'https://other.example/npm/', 'pkg')?.value,
    ).toEqual({
      latest: '2.0.0',
    })
  })

  it('keeps names that differ only in case apart', () => {
    const cache = open()
    cache.put('dist-tags', REGISTRY, 'JSONStream', { latest: '1.0.0' }, PUBLIC)
    cache.put('dist-tags', REGISTRY, 'jsonstream', { latest: '2.0.0' }, PUBLIC)
    expect(entryFiles(cache, 'dist-tags')).toHaveLength(2)
  })

  it('keeps each kind in its own directory', () => {
    const cache = open()
    cache.put('dist-tags', REGISTRY, 'pkg', { latest: '1.0.0' }, PUBLIC)
    cache.put('deps.dev', REGISTRY, 'pkg', versions('1.0.0'), PUBLIC)
    cache.put('packument', REGISTRY, 'pkg', { versions: [] }, PUBLIC)
    cache.put('packument-full', REGISTRY, 'pkg', { versions: [] }, PUBLIC)
    for (const kind of Object.keys(TTL_SECONDS) as CacheKind[])
      expect(entryFiles(cache, kind)).toHaveLength(1)
    expect(cache.get('deps.dev', REGISTRY, 'pkg')?.value).toEqual(
      versions('1.0.0'),
    )
  })
})

describe('credentials', () => {
  it('keeps userinfo, query and hash out of keys and files', () => {
    const cache = open()
    const secret = 'https://user:SECRET@host.example/path/?token=Q#frag'
    cache.put(
      'packument',
      secret,
      'pkg',
      { latest: '1.0.0', versions: versions('1.0.0') },
      { authenticated: true, cacheControl: 'public, max-age=300', etag: '"e"' },
    )
    cache.put(
      'dist-tags',
      secret,
      'pkg',
      { latest: '1.0.0' },
      { authenticated: true },
      { sameForEveryone: true },
    )
    const files = walk(cache.dir)
    expect(files.length).toBeGreaterThan(2)
    for (const file of files) {
      const text = file.endsWith('.gz')
        ? zlib.gunzipSync(fs.readFileSync(file)).toString()
        : fs.readFileSync(file, 'utf8')
      for (const leak of ['SECRET', 'user:', 'token=', 'frag', 'user'])
        expect(text).not.toContain(leak)
      expect(file).not.toContain('SECRET')
    }
    const entry = JSON.parse(
      zlib
        .gunzipSync(
          fs.readFileSync(
            path.join(
              kindDir(cache, 'packument'),
              entryFiles(cache, 'packument')[0] ?? '',
            ),
          ),
        )
        .toString(),
    )
    expect(entry.endpoint).toBeUndefined()
    expect(
      cache.get('packument', 'https://host.example/path/', 'pkg'),
    ).toBeDefined()
  })
})

describe('a token in the registry path', () => {
  it('is in no file, no key, no name and no debug line', () => {
    const cache = open()
    const registry = 'https://npm-proxy.fury.io/PATHTOKEN123/acme/'
    cache.put(
      'packument',
      registry,
      'pkg',
      { latest: '1.0.0', versions: versions('1.0.0') },
      { authenticated: true, etag: '"e"' },
    )
    cache.put(
      'dist-tags',
      registry,
      'pkg',
      { latest: '1.0.0' },
      { authenticated: true },
      { sameForEveryone: true },
    )
    const files = walk(cache.dir)
    expect(files.length).toBeGreaterThan(2)
    for (const file of files) {
      const text = file.endsWith('.gz')
        ? zlib.gunzipSync(fs.readFileSync(file)).toString()
        : fs.readFileSync(file, 'utf8')
      expect(text).not.toContain('PATHTOKEN123')
      expect(text).not.toContain('fury.io')
      expect(file).not.toContain('PATHTOKEN123')
    }
    expect(cache.get('packument', registry, 'pkg')?.etag).toBe('"e"')
    expect(
      cache.get('packument', 'https://npm-proxy.fury.io/OTHER/acme/', 'pkg'),
    ).toBeUndefined()
    for (const [line] of jest.mocked(logger.debug).mock.calls)
      expect(String(line)).not.toContain('PATHTOKEN123')
  })

  it('prints no endpoint when a write fails', () => {
    const blocked = path.join(tmp, 'file')
    fs.writeFileSync(blocked, 'in the way')
    const cache = open({ dir: blocked })
    cache.put(
      'dist-tags',
      'https://npm-proxy.fury.io/PATHTOKEN123/acme/',
      'pkg',
      { latest: '1.0.0' },
      PUBLIC,
    )
    const lines = jest.mocked(logger.debug).mock.calls.map(([l]) => String(l))
    expect(lines.length).toBeGreaterThan(0)
    for (const line of lines) expect(line).not.toContain('PATHTOKEN123')
  })
})

describe('atomic writes', () => {
  it('keeps the old entry and leaves no temp file when the rename fails', () => {
    const cache = open()
    cache.put('dist-tags', REGISTRY, 'pkg', { latest: '1.0.0' }, PUBLIC)
    jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('EPERM: locked'), { code: 'EPERM' })
    })
    clock += 1000
    expect(
      cache.put('dist-tags', REGISTRY, 'pkg', { latest: '2.0.0' }, PUBLIC),
    ).toBe(false)
    expect(cache.get('dist-tags', REGISTRY, 'pkg')?.value).toEqual({
      latest: '1.0.0',
    })
    expect(
      names(kindDir(cache, 'dist-tags')).filter((n) => n.endsWith('.tmp')),
    ).toEqual([])
    expect(logger.debug).toHaveBeenCalledTimes(1)
    expect(cache.stats().failedWrites).toBe(1)
    // A refused rename is about that file, so later writes still happen.
    expect(
      cache.put('dist-tags', REGISTRY, 'pkg', { latest: '3.0.0' }, PUBLIC),
    ).toBe(true)
  })

  it('leaves no temp file when the target cannot be replaced', () => {
    const cache = open()
    cache.put('dist-tags', REGISTRY, 'pkg', { latest: '1.0.0' }, PUBLIC)
    const [name] = entryFiles(cache, 'dist-tags')
    const file = path.join(kindDir(cache, 'dist-tags'), name ?? '')
    fs.rmSync(file)
    fs.mkdirSync(file)
    expect(
      cache.put('dist-tags', REGISTRY, 'pkg', { latest: '2.0.0' }, PUBLIC),
    ).toBe(false)
    expect(
      names(kindDir(cache, 'dist-tags')).filter((n) => n.endsWith('.tmp')),
    ).toEqual([])
  })

  it('never shows a reader a partial entry while processes write one key', async () => {
    const dir = path.join(tmp, 'shared')
    const root = path.join(__dirname, '..', '..')
    const writer = path.join(__dirname, '..', 'fixtures', 'cacheWriter.ts')
    const register = path.join(root, 'bench', 'register.cjs')
    const ids = ['a', 'b', 'c', 'd']

    let running = ids.length
    const exits = ids.map(
      (id) =>
        new Promise<void>((resolve, reject) => {
          const child = spawn(
            process.execPath,
            ['-r', register, writer, dir, '50', id],
            { cwd: root, stdio: ['ignore', 'ignore', 'pipe'] },
          )
          let stderr = ''
          child.stderr.on('data', (chunk) => {
            stderr += String(chunk)
          })
          child.on('error', reject)
          child.on('exit', (code) => {
            running--
            if (code === 0) resolve()
            else reject(new Error(`writer ${id} exited ${code}: ${stderr}`))
          })
        }),
    )
    // Surface a failed writer without leaving the others unhandled.
    const settled = Promise.allSettled(exits)

    const reader = createRegistryCache({ dir })
    let seen = false
    const check = (): void => {
      const entry = reader.get(
        'packument',
        'https://registry.example/',
        'contended',
      )
      if (!entry) {
        // Windows may refuse a read for the instant a rename lands.
        if (seen && POSIX)
          throw new Error('an entry that existed became unreadable')
        return
      }
      seen = true
      const { versions: list = [], latest } = entry.value
      expect(list).toHaveLength(301)
      expect(list.at(-1)?.version).toBe(latest)
      expect(
        new Set(list.slice(0, -1).map((v) => v.deprecatedReason)).size,
      ).toBe(1)
    }
    while (running > 0) {
      check()
      await new Promise((resolve) => setImmediate(resolve))
    }
    const results = await settled
    for (const result of results)
      if (result.status === 'rejected') throw result.reason

    check()
    expect(seen).toBe(true)
    const folder = path.join(dir, 'v1', 'packument')
    expect(names(folder).filter((n) => n.endsWith('.tmp'))).toEqual([])
    expect(names(folder)).toHaveLength(1)
  })
})

describe('pruning', () => {
  const putBulky = (cache: RegistryCache, index: number): void => {
    clock += 1000
    cache.put('packument', REGISTRY, `pkg-${index}`, bulky(index), PUBLIC)
  }
  const stillThere = (cache: RegistryCache, count: number): number[] =>
    Array.from({ length: count }, (_, index) => index).filter((index) =>
      fs.existsSync(
        path.join(
          kindDir(cache, 'packument'),
          `${crypto.createHash('sha256').update(`${REGISTRY}\npkg-${index}`).digest('hex')}.json.gz`,
        ),
      ),
    )
  const blockOf = (cache: RegistryCache): number => {
    const [name] = entryFiles(cache, 'packument')
    const size = fs.statSync(
      path.join(kindDir(cache, 'packument'), name ?? ''),
    ).size
    return Math.ceil(size / 4096) * 4096
  }

  it('deletes the oldest down to 80% of the cap', () => {
    const maxBytes = 64 * 1024
    const cache = open({ maxBytes })
    for (let index = 0; index < 30; index++) putBulky(cache, index)
    const block = blockOf(cache)
    expect(block * 30).toBeGreaterThan(maxBytes)
    cache.close()
    const keep = Math.floor((maxBytes * 0.8) / block)
    expect(stillThere(cache, 30)).toEqual(
      Array.from({ length: keep }, (_, i) => 30 - keep + i),
    )
    expect(cache.stats().pruned).toBe(30 - keep)
  })

  it('leaves a folder under the cap alone', () => {
    const cache = open({ maxBytes: 1024 * 1024 })
    for (let index = 0; index < 5; index++) putBulky(cache, index)
    cache.close()
    expect(stillThere(cache, 5)).toHaveLength(5)
  })

  it('counts a get as use', () => {
    const maxBytes = 64 * 1024
    const cache = open({ maxBytes })
    for (let index = 0; index < 10; index++) putBulky(cache, index)
    clock += 1000
    expect(cache.get('packument', REGISTRY, 'pkg-0')).toBeDefined()
    cache.close()
    const keep = Math.floor((maxBytes * 0.8) / blockOf(cache))
    expect(stillThere(cache, 10)).toEqual([
      0,
      ...Array.from({ length: keep - 1 }, (_, i) => 10 - (keep - 1) + i),
    ])
  })

  it('counts sizes in 4 KiB units', () => {
    const cache = open({ maxBytes: 3 * 4096 })
    for (let index = 0; index < 10; index++) {
      clock += 1000
      cache.put(
        'dist-tags',
        REGISTRY,
        `pkg-${index}`,
        { latest: '1.0.0' },
        PUBLIC,
      )
    }
    const [name] = entryFiles(cache, 'dist-tags')
    expect(
      fs.statSync(path.join(kindDir(cache, 'dist-tags'), name ?? '')).size,
    ).toBeLessThan(4096)
    cache.close()
    expect(entryFiles(cache, 'dist-tags')).toHaveLength(
      Math.floor((3 * 4096 * 0.8) / 4096),
    )
  })

  it('scans only when the run grew the folder', () => {
    const dir = path.join(tmp, 'cache')
    const first = open({ dir })
    first.put('dist-tags', REGISTRY, 'pkg', { latest: '1.0.0' }, PUBLIC)
    first.close()

    const old = path.join(dir, 'v1', 'dist-tags', 'x.json.gz.1.deadbeef.tmp')
    fs.writeFileSync(old, 'x')
    const hours = (clock - 2 * 3600_000) / 1000
    fs.utimesSync(old, hours, hours)

    const rewrite = open({ dir })
    clock += 1000
    rewrite.put('dist-tags', REGISTRY, 'pkg', { latest: '1.0.0' }, PUBLIC)
    rewrite.close()
    expect(fs.existsSync(old)).toBe(true)

    const grow = open({ dir })
    grow.put('dist-tags', REGISTRY, 'other', { latest: '1.0.0' }, PUBLIC)
    grow.close()
    expect(fs.existsSync(old)).toBe(false)
  })

  it('scans after an entry grows past a block boundary', () => {
    const dir = path.join(tmp, 'cache')
    const first = open({ dir })
    first.put('packument', REGISTRY, 'pkg', { versions: [] }, PUBLIC)
    first.close()
    const old = path.join(dir, 'v1', 'packument', 'x.json.gz.1.deadbeef.tmp')
    fs.writeFileSync(old, 'x')
    const hours = (clock - 2 * 3600_000) / 1000
    fs.utimesSync(old, hours, hours)

    const grow = open({ dir })
    grow.put('packument', REGISTRY, 'pkg', bulky(1), PUBLIC)
    grow.close()
    expect(fs.existsSync(old)).toBe(false)
  })

  it('removes a temp file older than an hour and keeps a younger one', () => {
    const cache = open()
    cache.put('dist-tags', REGISTRY, 'seed', { latest: '1.0.0' }, PUBLIC)
    const folder = kindDir(cache, 'dist-tags')
    const stale = path.join(folder, 'a.json.gz.1.00000000.tmp')
    const young = path.join(folder, 'b.json.gz.2.00000000.tmp')
    fs.writeFileSync(stale, 'x')
    fs.writeFileSync(young, 'x')
    const older = (clock - 3600_000 - 1000) / 1000
    const newer = (clock - 600_000) / 1000
    fs.utimesSync(stale, older, older)
    fs.utimesSync(young, newer, newer)
    cache.close()
    expect(fs.existsSync(stale)).toBe(false)
    expect(fs.existsSync(young)).toBe(true)
  })

  it('never deletes a file it did not make', () => {
    const maxBytes = 32 * 1024
    const cache = open({ maxBytes })
    putBulky(cache, 0)
    const folder = kindDir(cache, 'packument')
    const upper = `${'A'.repeat(64)}.json.gz`
    const short = `${'a'.repeat(63)}.json.gz`
    const user = [
      path.join(folder, 'notes.txt'),
      path.join(folder, upper),
      path.join(folder, short),
      path.join(folder, `${'a'.repeat(64)}.json.gz.bak`),
      path.join(cache.dir, 'v1', `${'b'.repeat(64)}.json.gz`),
      path.join(cache.dir, `${'c'.repeat(64)}.json.gz`),
      path.join(cache.dir, 'v1', 'elsewhere', `${'d'.repeat(64)}.json.gz`),
    ]
    fs.mkdirSync(path.join(cache.dir, 'v1', 'elsewhere'), { recursive: true })
    const ancient = (clock - 1e9) / 1000
    for (const file of user) {
      fs.writeFileSync(file, 'x'.repeat(10_000))
      fs.utimesSync(file, ancient, ancient)
    }
    for (let index = 1; index < 20; index++) putBulky(cache, index)
    cache.close()
    expect(cache.stats().pruned).toBeGreaterThan(0)
    for (const file of user) expect(fs.existsSync(file)).toBe(true)
  })

  it('is safe to close twice, or before any write', () => {
    const cache = open()
    cache.close()
    cache.close()
    expect(fs.existsSync(cache.dir)).toBe(false)
    putBulky(cache, 0)
    cache.close()
    cache.close()
  })

  it('writes CACHEDIR.TAG once, inside v1/', () => {
    const cache = open()
    cache.put('dist-tags', REGISTRY, 'a', { latest: '1.0.0' }, PUBLIC)
    const tag = path.join(cache.dir, 'v1', 'CACHEDIR.TAG')
    expect(fs.readFileSync(tag, 'utf8')).toMatch(
      /^Signature: 8a477f597d28d172789f06886806bc55\n/,
    )
    fs.writeFileSync(tag, 'mine')
    cache.put('dist-tags', REGISTRY, 'b', { latest: '1.0.0' }, PUBLIC)
    open().put('dist-tags', REGISTRY, 'c', { latest: '1.0.0' }, PUBLIC)
    expect(fs.readFileSync(tag, 'utf8')).toBe('mine')
  })

  it('never tags the folder the user named', () => {
    const named = path.join(tmp, 'project')
    fs.mkdirSync(named)
    fs.writeFileSync(path.join(named, 'package.json'), '{}')
    const cache = open({ dir: named })
    cache.put('dist-tags', REGISTRY, 'a', { latest: '1.0.0' }, PUBLIC)
    cache.close()
    expect(names(named)).toEqual(['package.json', 'v1'])
  })
})

describe('failing open', () => {
  it('stops writing when the folder path is a file', () => {
    const file = path.join(tmp, 'file')
    fs.writeFileSync(file, 'in the way')
    const cache = open({ dir: file })
    const mkdir = jest.spyOn(fs, 'mkdirSync')
    expect(cache.get('dist-tags', REGISTRY, 'pkg')).toBeUndefined()
    expect(
      cache.put('dist-tags', REGISTRY, 'pkg', { latest: '1.0.0' }, PUBLIC),
    ).toBe(false)
    expect(
      cache.put('dist-tags', REGISTRY, 'two', { latest: '1.0.0' }, PUBLIC),
    ).toBe(false)
    expect(logger.debug).toHaveBeenCalledTimes(1)
    expect(mkdir).toHaveBeenCalledTimes(1)
    cache.close()
    expect(fs.readFileSync(file, 'utf8')).toBe('in the way')
  })

  const unwritable = POSIX && process.getuid?.() !== 0 ? it : it.skip
  unwritable('stops writing when the folder is read-only', () => {
    const dir = path.join(tmp, 'locked')
    fs.mkdirSync(dir, { mode: 0o700 })
    fs.chmodSync(dir, 0o500)
    try {
      const cache = open({ dir })
      expect(
        cache.put('dist-tags', REGISTRY, 'pkg', { latest: '1.0.0' }, PUBLIC),
      ).toBe(false)
      expect(
        cache.put('dist-tags', REGISTRY, 'two', { latest: '1.0.0' }, PUBLIC),
      ).toBe(false)
      expect(logger.debug).toHaveBeenCalledTimes(1)
      expect(cache.get('dist-tags', REGISTRY, 'pkg')).toBeUndefined()
      expect(() => cache.close()).not.toThrow()
    } finally {
      fs.chmodSync(dir, 0o700)
    }
  })
})

describe('POSIX modes', () => {
  const posix = POSIX ? it : it.skip

  posix('creates directories 0o700 and files 0o600', () => {
    const cache = open()
    cache.put('dist-tags', REGISTRY, 'pkg', { latest: '1.0.0' }, PUBLIC)
    const mode = (target: string): number => fs.statSync(target).mode & 0o777
    expect(mode(cache.dir)).toBe(0o700)
    expect(mode(path.join(cache.dir, 'v1'))).toBe(0o700)
    expect(mode(kindDir(cache, 'dist-tags'))).toBe(0o700)
    expect(
      mode(
        path.join(
          kindDir(cache, 'dist-tags'),
          entryFiles(cache, 'dist-tags')[0] ?? '',
        ),
      ),
    ).toBe(0o600)
  })
})
