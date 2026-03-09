import type { PackageInfo } from '@/types'
import type filterPackagesType from '@/utils/filterPackages'

const mockLogger = {
  __esModule: true,
  default: {
    error: jest.fn(),
    skippingPackage: jest.fn(),
  },
}

function loadFilterWithConfig(config: Record<string, unknown>) {
  let filter: typeof filterPackagesType
  jest.isolateModules(() => {
    jest.doMock('@/utils/config', () => ({
      loadConfig: () => ({
        allowMinorUpdates: false,
        allowMajorUpdates: false,
        debug: false,
        silent: false,
        updateAllowlist: [],
        updateDenylist: [],
        ...config,
      }),
    }))
    jest.doMock('@/utils/logger', () => mockLogger)
    // biome-ignore lint/style/noCommonJs: jest.isolateModules requires synchronous require
    filter = require('@/utils/filterPackages').default
  })
  return filter!
}

const makeOutdated = (
  packages: Array<{ name: string; current: string; latest: string }>,
): Record<string, PackageInfo> => {
  const result: Record<string, PackageInfo> = {}
  for (const pkg of packages) {
    result[pkg.name] = pkg
  }
  return result
}

describe('filterPackages', () => {
  it('returns update results for all packages', () => {
    const filter = loadFilterWithConfig({})
    const outdated = makeOutdated([
      { name: 'foo', current: '1.0.0', latest: '1.0.1' },
      { name: 'bar', current: '1.0.0', latest: '2.0.0' },
    ])

    const results = filter(outdated)

    expect(results).toHaveLength(2)
    expect(results[0].name).toBe('foo')
    expect(results[0].updated).toBe(true)
    expect(results[0].updateType).toBe('patch')
    expect(results[1].name).toBe('bar')
    expect(results[1].updated).toBe(false)
    expect(results[1].updateType).toBe('major')
  })

  it('marks targeted packages as eligible and others as not targeted', () => {
    const filter = loadFilterWithConfig({})
    const outdated = makeOutdated([
      { name: 'foo', current: '1.0.0', latest: '1.0.1' },
      { name: 'bar', current: '1.0.0', latest: '1.0.2' },
      { name: 'baz', current: '1.0.0', latest: '1.0.3' },
    ])

    const results = filter(outdated, ['foo', 'baz'])

    expect(results.find((r) => r.name === 'foo')?.updated).toBe(true)
    expect(results.find((r) => r.name === 'bar')?.updated).toBe(false)
    expect(results.find((r) => r.name === 'bar')?.reason).toBe('not targeted')
    expect(results.find((r) => r.name === 'baz')?.updated).toBe(true)
  })

  it('respects config when targeting packages', () => {
    const filter = loadFilterWithConfig({ updateDenylist: ['foo'] })
    const outdated = makeOutdated([
      { name: 'foo', current: '1.0.0', latest: '1.0.1' },
      { name: 'bar', current: '1.0.0', latest: '1.0.2' },
    ])

    const results = filter(outdated, ['foo', 'bar'])

    expect(results.find((r) => r.name === 'foo')?.updated).toBe(false)
    expect(results.find((r) => r.name === 'foo')?.reason).toBe(
      'skipped by config',
    )
    expect(results.find((r) => r.name === 'bar')?.updated).toBe(true)
  })

  it('includes updateType for all results', () => {
    const filter = loadFilterWithConfig({ allowMajorUpdates: true })
    const outdated = makeOutdated([
      { name: 'patch-pkg', current: '1.0.0', latest: '1.0.1' },
      { name: 'minor-pkg', current: '1.0.0', latest: '1.1.0' },
      { name: 'major-pkg', current: '1.0.0', latest: '2.0.0' },
    ])

    const results = filter(outdated)

    expect(results.find((r) => r.name === 'patch-pkg')?.updateType).toBe(
      'patch',
    )
    expect(results.find((r) => r.name === 'minor-pkg')?.updateType).toBe(
      'minor',
    )
    expect(results.find((r) => r.name === 'major-pkg')?.updateType).toBe(
      'major',
    )
  })

  it('returns empty array for empty input', () => {
    const filter = loadFilterWithConfig({})
    const results = filter({})
    expect(results).toEqual([])
  })

  it('handles empty target packages array same as no targeting', () => {
    const filter = loadFilterWithConfig({})
    const outdated = makeOutdated([
      { name: 'foo', current: '1.0.0', latest: '1.0.1' },
    ])

    const withEmpty = filter(outdated, [])
    const withUndefined = filter(outdated)

    // Empty array passes the length > 0 check, so behaves like no targeting
    expect(withEmpty[0].updated).toBe(true)
    expect(withUndefined[0].updated).toBe(true)
  })
})
