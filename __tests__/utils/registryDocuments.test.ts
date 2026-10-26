import {
  parseDepsDevPackage,
  parseDistTags,
  parsePackument,
} from '@/utils/registryDocuments'
import { registryBody } from '../fixtures/registry'

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
