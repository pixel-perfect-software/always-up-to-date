import type { PackageInfo } from '@/types'
import {
  getSortedGroupNames,
  groupAndSortPackages,
} from '@/utils/packageGrouper'

const makeInfo = (name: string): PackageInfo => ({
  name,
  current: '1.0.0',
  latest: '2.0.0',
})

describe('groupAndSortPackages', () => {
  it('groups scoped packages by scope', () => {
    const packages: Record<string, PackageInfo> = {
      '@babel/core': makeInfo('@babel/core'),
      '@babel/preset-env': makeInfo('@babel/preset-env'),
      lodash: makeInfo('lodash'),
    }

    const grouped = groupAndSortPackages(packages)

    expect(grouped['@babel']).toHaveLength(2)
    expect(grouped.unscoped).toHaveLength(1)
  })

  it('sorts packages within groups alphabetically', () => {
    const packages: Record<string, PackageInfo> = {
      '@babel/preset-env': makeInfo('@babel/preset-env'),
      '@babel/core': makeInfo('@babel/core'),
    }

    const grouped = groupAndSortPackages(packages)

    expect(grouped['@babel'][0].name).toBe('@babel/core')
    expect(grouped['@babel'][1].name).toBe('@babel/preset-env')
  })

  it('puts all unscoped packages in the unscoped group', () => {
    const packages: Record<string, PackageInfo> = {
      lodash: makeInfo('lodash'),
      express: makeInfo('express'),
    }

    const grouped = groupAndSortPackages(packages)

    expect(Object.keys(grouped)).toEqual(['unscoped'])
    expect(grouped.unscoped).toHaveLength(2)
  })

  it('handles empty input', () => {
    const grouped = groupAndSortPackages({})
    expect(Object.keys(grouped)).toHaveLength(0)
  })
})

describe('getSortedGroupNames', () => {
  it('places scoped groups before unscoped', () => {
    const grouped = {
      unscoped: [{ name: 'lodash', info: makeInfo('lodash') }],
      '@babel': [{ name: '@babel/core', info: makeInfo('@babel/core') }],
      '@types': [{ name: '@types/node', info: makeInfo('@types/node') }],
    }

    const names = getSortedGroupNames(grouped)

    expect(names).toEqual(['@babel', '@types', 'unscoped'])
  })

  it('returns empty array for empty input', () => {
    expect(getSortedGroupNames({})).toEqual([])
  })

  it('omits unscoped if not present', () => {
    const grouped = {
      '@babel': [{ name: '@babel/core', info: makeInfo('@babel/core') }],
    }

    expect(getSortedGroupNames(grouped)).toEqual(['@babel'])
  })
})
