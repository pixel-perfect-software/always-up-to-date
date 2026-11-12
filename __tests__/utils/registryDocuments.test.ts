import semver from 'semver'
import {
  parseDepsDevPackage,
  parseDistTags,
  parsePackument,
  parseVersionManifest,
} from '@/utils/registryDocuments'
import { derive, registryBody } from '../fixtures/registry'

const json = (name: string): unknown => JSON.parse(registryBody(name))

describe('parseDistTags', () => {
  it.each([
    ['ms', '2.1.3'],
    ['types-ms', '2.1.0'],
    ['mkdirp', '3.0.1'],
  ])('reads latest for %s', (name, latest) => {
    expect(parseDistTags(json(`${name}.dist-tags`))).toBe(latest)
  })

  it.each([
    ['a non-object', 'latest'],
    ['an array', ['2.1.3']],
    ['no latest', { beta: '3.0.0-beta.2' }],
    ['a latest that is not a string', { latest: 3 }],
    ['a latest that is not canonical semver', { latest: 'v2.1.3' }],
    ['a latest that is a range', { latest: '^2.1.3' }],
  ])('returns undefined for %s', (_label, body) => {
    expect(parseDistTags(body)).toBeUndefined()
  })
})

describe('parseDepsDevPackage', () => {
  it('lists every version ascending with its publish time', () => {
    const versions = parseDepsDevPackage(json('ms.deps-dev'))

    expect(versions).toHaveLength(32)
    expect(versions?.at(-1)).toEqual({
      version: '4.0.0-nightly.202508271359',
      deprecated: false,
      publishedAt: expect.any(String),
    })
    expect(versions?.find((v) => v.version === '2.1.3')).toEqual({
      version: '2.1.3',
      deprecated: false,
      publishedAt: expect.stringMatching(/^20\d\d-\d\d-\d\dT/),
    })
    expect(versions?.every((v) => v.publishedAt)).toBe(true)
  })

  it('carries deprecation as a flag, with the reason when there is one', () => {
    const versions = parseDepsDevPackage(json('mkdirp.deps-dev')) ?? []
    const deprecated = versions.filter((v) => v.deprecated)

    expect(deprecated).toHaveLength(25)
    expect(deprecated[0]).toEqual({
      version: '0.0.1',
      deprecated: true,
      deprecatedReason: expect.stringContaining('no longer supported'),
      publishedAt: '2011-01-06T02:54:36Z',
    })
    expect(versions.find((v) => v.version === '3.0.1')?.deprecated).toBe(false)
  })

  it('keeps a deprecation that has no reason', () => {
    const body = {
      versions: [
        { versionKey: { version: '1.0.0' }, isDeprecated: true },
        {
          versionKey: { version: '1.1.0' },
          isDeprecated: true,
          deprecatedReason: '',
        },
      ],
    }

    expect(parseDepsDevPackage(body)).toEqual([
      { version: '1.0.0', deprecated: true },
      { version: '1.1.0', deprecated: true },
    ])
  })

  it('sorts by semver, not by string', () => {
    const body = {
      versions: ['1.10.0', '1.2.0', '1.9.0-rc.1'].map((version) => ({
        versionKey: { version },
      })),
    }

    expect(parseDepsDevPackage(body)?.map((v) => v.version)).toEqual([
      '1.2.0',
      '1.9.0-rc.1',
      '1.10.0',
    ])
  })

  it('drops non-canonical versions and unparseable timestamps', () => {
    const body = {
      versions: [
        { versionKey: { version: 'v1.0.0' } },
        { versionKey: { version: '1.0' } },
        { versionKey: { version: '2.0.0' }, publishedAt: 'yesterday' },
        { versionKey: {} },
        'junk',
        null,
      ],
    }

    expect(parseDepsDevPackage(body)).toEqual([
      { version: '2.0.0', deprecated: false },
    ])
  })

  it.each([
    ['a non-object', 'x'],
    ['null', null],
    ['no versions', {}],
    ['versions that is an object', { versions: {} }],
    ['versions that is a string', { versions: '1.0.0' }],
  ])('returns undefined for %s', (_label, body) => {
    expect(parseDepsDevPackage(body)).toBeUndefined()
  })
})

describe('parsePackument', () => {
  it('reads an abbreviated packument: latest and versions, no publish times', () => {
    const packument = parsePackument(json('ms.packument'))

    expect(packument?.latest).toBe('2.1.3')
    expect(packument?.versions).toHaveLength(32)
    expect(packument?.versions.some((v) => v.publishedAt)).toBe(false)
  })

  it('reads a full packument: a publish time for every version', () => {
    const packument = parsePackument(json('types-ms.packument-full'))

    expect(packument?.latest).toBe('2.1.0')
    expect(packument?.versions).toHaveLength(17)
    expect(packument?.versions.every((v) => v.publishedAt)).toBe(true)
  })

  it('reads deprecation from the version manifests', () => {
    const versions = parsePackument(json('mkdirp.packument'))?.versions ?? []

    expect(versions.filter((v) => v.deprecated)).toHaveLength(25)
    expect(versions.find((v) => v.version === '0.0.1')).toEqual({
      version: '0.0.1',
      deprecated: true,
      deprecatedReason: expect.stringContaining('no longer supported'),
    })
  })

  it('treats an empty deprecated string as not deprecated and true as deprecated', () => {
    const body = {
      versions: {
        '1.0.0': { deprecated: '' },
        '1.1.0': { deprecated: true },
        '1.2.0': { deprecated: 'use 2' },
        '1.3.0': {},
      },
    }

    expect(parsePackument(body)?.versions).toEqual([
      { version: '1.0.0', deprecated: false },
      { version: '1.1.0', deprecated: true },
      { version: '1.2.0', deprecated: true, deprecatedReason: 'use 2' },
      { version: '1.3.0', deprecated: false },
    ])
  })

  it.each([
    ['ms', 'ms'],
    ['types-ms', 'types-ms'],
    ['mkdirp', 'mkdirp'],
  ])(
    'agrees with deps.dev on the versions and the deprecated ones for %s',
    (name) => {
      const fromDepsDev = parseDepsDevPackage(json(`${name}.deps-dev`)) ?? []
      const fromPackument =
        parsePackument(json(`${name}.packument`))?.versions ?? []

      expect(fromPackument.map((v) => v.version)).toEqual(
        fromDepsDev.map((v) => v.version),
      )
      expect(
        fromPackument.filter((v) => v.deprecated).map((v) => v.version),
      ).toEqual(fromDepsDev.filter((v) => v.deprecated).map((v) => v.version))
    },
  )

  it('keeps only canonical semver keys, including when the key is __proto__', () => {
    const body = JSON.parse(
      '{"versions":{"__proto__":{},"latest":{},"1.0":{},"1.0.0":{}}}',
    )

    expect(parsePackument(body)?.versions).toEqual([
      { version: '1.0.0', deprecated: false },
    ])
  })

  it('ignores a time entry that is not an own, parseable timestamp', () => {
    const body = {
      versions: { '1.0.0': {}, '1.1.0': {} },
      time: { '1.0.0': 'never', modified: '2026-01-01T00:00:00.000Z' },
    }

    expect(parsePackument(body)?.versions).toEqual([
      { version: '1.0.0', deprecated: false },
      { version: '1.1.0', deprecated: false },
    ])
  })

  it('keeps only the string entries of time, and only for versions the document lists', () => {
    const body = JSON.parse(
      derive<{
        versions: Record<string, unknown>
        time: Record<string, unknown>
      }>('types-ms.packument-full', (full) => {
        full.time['2.1.0'] = 7
        full.time['0.7.34'] = null
        // Unpublished, but the registry keeps its time entry.
        delete full.versions['0.7.33']
      }),
    )

    const versions = parsePackument(body)?.versions ?? []

    expect(versions).toHaveLength(16)
    expect(versions.find((v) => v.version === '0.7.33')).toBeUndefined()
    expect(versions.find((v) => v.version === '2.1.0')?.publishedAt).toBe(
      undefined,
    )
    expect(versions.find((v) => v.version === '0.7.34')?.publishedAt).toBe(
      undefined,
    )
    expect(versions.find((v) => v.version === '0.7.32')?.publishedAt).toBe(
      '2023-09-27T10:26:06.002Z',
    )
    expect(versions.filter((v) => v.publishedAt)).toHaveLength(14)
  })

  describe('modified (#177)', () => {
    it.each([
      ['ms', '2025-09-08T19:56:54.242Z'],
      ['types-ms', '2026-10-04T08:50:16.855Z'],
      ['mkdirp', '2026-07-17T17:10:12.862Z'],
    ])('reads the abbreviated capture of %s', (name, modified) => {
      expect(parsePackument(json(`${name}.packument`))?.modified).toBe(modified)
    })

    it('is an upper bound on every version time of the full capture, and equals its time.modified', () => {
      const full = json('types-ms.packument-full') as {
        time: Record<string, string>
      }
      const abbreviated = parsePackument(json('types-ms.packument'))
      const bound = Date.parse(abbreviated?.modified as string)

      expect(abbreviated?.modified).toBe(full.time.modified)
      const times = parsePackument(full)?.versions.map((v) => v.publishedAt)
      expect(times?.filter(Boolean).length).toBeGreaterThan(0)
      for (const published of times ?? []) {
        if (published) expect(Date.parse(published)).toBeLessThanOrEqual(bound)
      }
    })

    it('is absent from a full document, whose bound is time.modified', () => {
      expect(
        parsePackument(json('types-ms.packument-full'))?.modified,
      ).toBeUndefined()
    })

    it.each([
      ['a non-date string', 'yesterday'],
      ['a number', 1760000000000],
      ['null', null],
    ])('is absent for %s', (_label, value) => {
      const body = JSON.parse(
        derive<{ modified: unknown }>('ms.packument', (doc) => {
          doc.modified = value
        }),
      )
      expect(parsePackument(body)?.modified).toBeUndefined()
    })
  })

  it('leaves latest out when dist-tags has none that is valid', () => {
    expect(
      parsePackument({
        versions: { '1.0.0': {} },
        'dist-tags': { latest: 'x' },
      })?.latest,
    ).toBeUndefined()
  })

  it.each([
    ['a non-object', 3],
    ['null', null],
    ['versions of the wrong type', { versions: ['1.0.0'] }],
    ['no versions', { 'dist-tags': { latest: '1.0.0' } }],
  ])('returns undefined for %s', (_label, body) => {
    expect(parsePackument(body)).toBeUndefined()
  })
})

describe('parseVersionManifest (#196)', () => {
  const manifest = (name: string, version: string, capture: string) =>
    parseVersionManifest(json(`${capture}.manifest`), { name, version })

  it.each([
    [
      'ms',
      '2.1.3',
      'ms.2.1.3',
      {
        license: 'MIT',
        peerDependencies: {},
        optionalPeers: [],
        deprecated: false,
      },
    ],
    [
      '@types/ms',
      '2.1.0',
      'types-ms.2.1.0',
      {
        license: 'MIT',
        peerDependencies: {},
        optionalPeers: [],
        deprecated: false,
      },
    ],
    [
      'mkdirp',
      '0.3.0',
      'mkdirp.0.3.0',
      {
        license: 'MIT/X11',
        enginesNode: '*',
        peerDependencies: {},
        optionalPeers: [],
        deprecated: true,
        deprecatedReason:
          'Legacy versions of mkdirp are no longer supported. Please update to mkdirp 1.x. (Note that the API surface has changed to use Promises in 1.x.)',
      },
    ],
    [
      'mkdirp',
      '3.0.1',
      'mkdirp.3.0.1',
      {
        license: 'MIT',
        enginesNode: '>=10',
        peerDependencies: {},
        optionalPeers: [],
        deprecated: false,
      },
    ],
    [
      'mkdirp',
      '0.5.6',
      'mkdirp.0.5.6',
      {
        license: 'MIT',
        peerDependencies: {},
        optionalPeers: [],
        deprecated: false,
      },
    ],
    [
      'react-redux',
      '9.2.0',
      'react-redux.9.2.0',
      {
        license: 'MIT',
        peerDependencies: {
          react: '^18.0 || ^19',
          redux: '^5.0.0',
          '@types/react': '^18.2.25 || ^19',
        },
        optionalPeers: ['@types/react', 'redux'],
        deprecated: false,
      },
    ],
    [
      'ms',
      '0.1.0',
      'ms.0.1.0',
      {
        enginesNode: '*',
        peerDependencies: {},
        optionalPeers: [],
        deprecated: false,
      },
    ],
    [
      'async',
      '0.2.10',
      'async.0.2.10',
      {
        license: 'MIT',
        peerDependencies: {},
        optionalPeers: [],
        deprecated: false,
      },
    ],
    [
      'minimatch',
      '0.2.14',
      'minimatch.0.2.14',
      {
        license: 'MIT',
        enginesNode: '*',
        peerDependencies: {},
        optionalPeers: [],
        deprecated: true,
        deprecatedReason:
          'Please update to minimatch 3.0.2 or higher to avoid a RegExp DoS issue',
      },
    ],
  ])('reads %s@%s from its capture', (name, version, capture, expected) => {
    expect(manifest(name, version, capture)).toEqual({
      name,
      version,
      ...expected,
    })
  })

  it("is undefined for the registry's 404 body, a JSON string", () => {
    expect(
      manifest(
        'ms',
        '0.0.0-autd-no-such-version',
        'ms.0.0.0-autd-no-such-version',
      ),
    ).toBeUndefined()
  })

  it.each([
    ['a number', 3],
    ['null', null],
    ['an array', [json('ms.2.1.3.manifest')]],
  ])('is undefined for %s', (_label, body) => {
    expect(
      parseVersionManifest(body, { name: 'ms', version: '2.1.3' }),
    ).toBeUndefined()
  })

  it('is undefined when the name or version is not the one asked for', () => {
    const body = json('ms.2.1.3.manifest')
    expect(
      parseVersionManifest(body, { name: 'mkdirp', version: '2.1.3' }),
    ).toBeUndefined()
    expect(
      parseVersionManifest(body, { name: 'ms', version: '2.1.2' }),
    ).toBeUndefined()
  })

  it('keeps only string peer ranges, and optional peers with or without one', () => {
    const body = derive<{
      peerDependencies: Record<string, unknown>
      peerDependenciesMeta: Record<string, unknown>
    }>('react-redux.9.2.0.manifest', (b) => {
      b.peerDependencies.redux = 5
      b.peerDependencies['@types/react'] = null
      b.peerDependenciesMeta['meta-only'] = { optional: true }
      b.peerDependenciesMeta.react = { optional: false }
      b.peerDependenciesMeta.odd = 'optional'
    })
    expect(
      parseVersionManifest(JSON.parse(body), {
        name: 'react-redux',
        version: '9.2.0',
      }),
    ).toMatchObject({
      peerDependencies: { react: '^18.0 || ^19' },
      optionalPeers: ['@types/react', 'meta-only', 'redux'],
    })
  })

  it('joins a licenses array of several entries as an SPDX OR', () => {
    const body = derive<{ licenses: Array<{ type: string; url: string }> }>(
      'async.0.2.10.manifest',
      (b) => {
        b.licenses.push({ type: 'Apache-2.0', url: 'https://example.test/' })
      },
    )
    expect(
      parseVersionManifest(JSON.parse(body), {
        name: 'async',
        version: '0.2.10',
      })?.license,
    ).toBe('(MIT OR Apache-2.0)')
  })

  // On ms 2.1.3, which has `license: "MIT"` and no `licenses`.
  it.each([
    ['no license for a blank one', { license: '  ' }, undefined],
    ['a license trimmed', { license: ' MIT ' }, 'MIT'],
    [
      'no license for an object without a type',
      { license: { url: 'x' } },
      undefined,
    ],
    ['no license for a number', { license: 3 }, undefined],
  ])('reads %s', (_label, edit, expected) => {
    const body = derive<Record<string, unknown>>('ms.2.1.3.manifest', (b) => {
      Object.assign(b, edit)
    })
    expect(
      parseVersionManifest(JSON.parse(body), { name: 'ms', version: '2.1.3' })
        ?.license,
    ).toBe(expected)
  })

  // On async 0.2.10, which has `licenses: [{ type: "MIT" }]` and no `license`.
  it.each([
    ['license over licenses', { license: 'ISC' }, 'ISC'],
    ['licenses when license is blank', { license: '' }, 'MIT'],
    [
      'no license for a licenses array of strings',
      { licenses: ['MIT'] },
      undefined,
    ],
    ['no license for an empty licenses array', { licenses: [] }, undefined],
  ])('reads %s', (_label, edit, expected) => {
    const body = derive<Record<string, unknown>>(
      'async.0.2.10.manifest',
      (b) => {
        Object.assign(b, edit)
      },
    )
    expect(
      parseVersionManifest(JSON.parse(body), {
        name: 'async',
        version: '0.2.10',
      })?.license,
    ).toBe(expected)
  })

  it('treats an empty deprecated string as not deprecated, as npm does', () => {
    const body = derive<Record<string, unknown>>('ms.2.1.3.manifest', (b) => {
      b.deprecated = ''
    })
    expect(
      parseVersionManifest(JSON.parse(body), { name: 'ms', version: '2.1.3' }),
    ).toMatchObject({ deprecated: false })
    expect(
      parseVersionManifest(JSON.parse(body), { name: 'ms', version: '2.1.3' }),
    ).not.toHaveProperty('deprecatedReason')
  })

  it.each([
    ['an array', ['node >= 10']],
    ['a node range that is not a string', { node: 10 }],
    ['an empty node range', { node: '' }],
  ])('has no enginesNode for engines as %s', (_label, engines) => {
    const body = derive<Record<string, unknown>>(
      'mkdirp.3.0.1.manifest',
      (b) => {
        b.engines = engines
      },
    )
    expect(
      parseVersionManifest(JSON.parse(body), {
        name: 'mkdirp',
        version: '3.0.1',
      }),
    ).not.toHaveProperty('enginesNode')
  })
})

describe('version order', () => {
  const ascending = (versions: string[]) =>
    [...versions].sort((a, b) => semver.compare(a, b))

  it('matches semver.compare on the whole next capture', () => {
    const parsed = parseDepsDevPackage(json('next.deps-dev'))?.map(
      (v) => v.version,
    )
    const document = json('next.deps-dev') as {
      versions: { versionKey: { version: string } }[]
    }
    const unsorted = document.versions.map((v) => v.versionKey.version)

    expect(parsed).toEqual(ascending(unsorted.filter((v) => semver.valid(v))))
  })

  it('drops versions that differ only in build metadata, so none reaches the sort tied', () => {
    const body = JSON.parse(
      derive<{ versions: { versionKey: { version: string } }[] }>(
        'ms.deps-dev',
        (doc) => {
          const [first] = doc.versions
          const base = first.versionKey.version
          for (const tag of ['+b', '+a']) {
            doc.versions.push({
              ...first,
              versionKey: { ...first.versionKey, version: `${base}${tag}` },
            })
          }
        },
      ),
    )
    const sorted = parseDepsDevPackage(body)?.map((v) => v.version)

    expect(sorted).toEqual(
      parseDepsDevPackage(json('ms.deps-dev'))?.map((v) => v.version),
    )
    expect(sorted?.some((v) => v.includes('+'))).toBe(false)
  })
})
