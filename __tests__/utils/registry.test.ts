jest.mock('npm-registry-fetch', () => ({
  __esModule: true,
  default: { json: jest.fn() },
}))
jest.mock('@/utils/logger')

import npmFetch from 'npm-registry-fetch'
import type { RegistryConfig } from '@/types'
import { clearRegistryCache, fetchReleaseTimes } from '@/utils/registry'

const config: RegistryConfig = {
  registry: 'https://registry.npmjs.org/',
  scopedRegistries: {},
  authTokens: {},
}

describe('fetchReleaseTimes', () => {
  beforeEach(() => {
    clearRegistryCache()
  })

  it('fetches a package once while several manifests ask for it at the same time', async () => {
    jest
      .mocked(npmFetch.json)
      .mockResolvedValue({ time: { '1.0.0': '2026-01-01T00:00:00.000Z' } })

    const times = await Promise.all([
      fetchReleaseTimes('dayjs', config),
      fetchReleaseTimes('dayjs', config),
      fetchReleaseTimes('dayjs', config),
    ])

    expect(npmFetch.json).toHaveBeenCalledTimes(1)
    expect(times).toEqual([
      { '1.0.0': '2026-01-01T00:00:00.000Z' },
      { '1.0.0': '2026-01-01T00:00:00.000Z' },
      { '1.0.0': '2026-01-01T00:00:00.000Z' },
    ])
  })

  it('fails open to an empty map, once, on a network error', async () => {
    jest.mocked(npmFetch.json).mockRejectedValue(new Error('ETIMEDOUT'))

    expect(await fetchReleaseTimes('ms', config)).toEqual({})
    expect(await fetchReleaseTimes('ms', config)).toEqual({})
    expect(npmFetch.json).toHaveBeenCalledTimes(1)
  })
})
