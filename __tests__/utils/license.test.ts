import { licenseField, normalizeLicense, sameLicense } from '@/utils/license'
import { derive, registryBody } from '../fixtures/registry'

const field = (capture: string): string | undefined =>
  licenseField(JSON.parse(registryBody(capture)))

describe('licenseField (#197)', () => {
  it('reads a license string from a real manifest', () => {
    expect(field('ms.2.1.3.manifest')).toBe('MIT')
    expect(field('pako.2.1.0.manifest')).toBe('(MIT AND Zlib)')
    expect(field('ua-parser-js.2.0.0.manifest')).toBe('AGPL-3.0-or-later')
  })

  it('is undefined for a manifest that declares none', () => {
    expect(field('ms.0.1.0.manifest')).toBeUndefined()
  })

  it('reads the legacy shapes of real manifests', () => {
    expect(field('async.0.2.10.manifest')).toBe('MIT')
    expect(field('minimatch.0.2.14.manifest')).toBe('MIT')
    expect(field('mkdirp.0.3.0.manifest')).toBe('MIT/X11')
  })

  it('gives several licenses[] entries as an OR, each once', () => {
    const body = (licenses: unknown) =>
      JSON.parse(
        derive('ms.0.1.0.manifest', (b: object) =>
          Object.assign(b, { licenses }),
        ),
      )
    expect(
      licenseField(
        body([{ type: 'MIT' }, { type: 'Apache-2.0' }, { type: 'MIT' }]),
      ),
    ).toBe('(MIT OR Apache-2.0)')
    expect(licenseField(body(['MIT', 'ISC']))).toBeUndefined()
    expect(licenseField(body([{ type: 'MIT' }, 'ISC']))).toBe('MIT')
  })

  it('ignores a number, an empty string and a blank type', () => {
    expect(licenseField({ license: 5 })).toBeUndefined()
    expect(licenseField({ license: '  ' })).toBeUndefined()
    expect(licenseField({ license: { type: ' ' } })).toBeUndefined()
    expect(licenseField({ license: '  ISC ' })).toBe('ISC')
  })
})

describe('sameLicense (#197)', () => {
  it.each([
    ['MIT', 'mit'],
    ['MIT', ' MIT '],
    ['MIT', '(MIT)'],
    ['MIT', '((MIT))'],
    ['(MIT OR Apache-2.0)', 'Apache-2.0 OR MIT'],
    ['MIT AND Zlib', '(Zlib AND MIT)'],
    ['MIT  OR   ISC', 'isc or mit'],
    ['GPL-3.0', 'GPL-3.0-only'],
    ['LGPL-2.1', 'LGPL-2.1-only'],
    ['AGPL-3.0', 'agpl-3.0-only'],
    ['GPL-2.0+', 'GPL-2.0-or-later'],
    ['GPL-2.0+ OR MIT', 'MIT OR GPL-2.0-or-later'],
    ['SEE LICENSE IN LICENSE', 'SEE LICENSE IN LICENSE.md'],
    ['See License in LICENCE', 'SEE LICENSE IN LICENSE.md'],
    ['(A OR B) AND C', '(A OR B) AND C'],
  ])('%j and %j are the same', (a, b) => {
    expect(sameLicense(a, b)).toBe(true)
  })

  it.each([
    ['MIT', 'ISC'],
    ['MIT/X11', 'MIT'],
    ['BSD', 'BSD-3-Clause'],
    ['Apache 2.0', 'Apache-2.0'],
    ['MIT OR ISC', 'MIT AND ISC'],
    ['GPL-3.0', 'GPL-3.0-or-later'],
    ['GPL-3.0-only', 'LGPL-3.0'],
    ['(A OR B) AND C', 'C AND (A OR B)'],
    ['MIT', 'MIT OR ISC'],
  ])('%j and %j differ', (a, b) => {
    expect(sameLicense(a, b)).toBe(false)
  })

  it('treats none as the same only as none', () => {
    expect(sameLicense(undefined, undefined)).toBe(true)
    expect(sameLicense(undefined, 'MIT')).toBe(false)
    expect(sameLicense('MIT', undefined)).toBe(false)
  })

  it('normalizes the real license texts', () => {
    expect(normalizeLicense('(MIT AND Zlib)')).toBe('MIT AND ZLIB')
  })
})
