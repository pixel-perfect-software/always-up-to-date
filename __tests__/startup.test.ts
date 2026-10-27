const mockClientLoaded = jest.fn()
jest.mock('@/utils/registryClient', () => {
  mockClientLoaded()
  return {}
})
const mockReaderLoaded = jest.fn()
jest.mock('@/utils/registryReader', () => {
  mockReaderLoaded()
  return {}
})
const mockCacheLoaded = jest.fn()
jest.mock('@/utils/registryCache', () => {
  mockCacheLoaded()
  return {}
})
jest.mock('@/utils/config')

describe('startup', () => {
  it('loads no registry client, reader or cache while the CLI loads', async () => {
    await import('@/cli')

    expect(mockClientLoaded).not.toHaveBeenCalled()
    expect(mockReaderLoaded).not.toHaveBeenCalled()
    expect(mockCacheLoaded).not.toHaveBeenCalled()
  })
})
