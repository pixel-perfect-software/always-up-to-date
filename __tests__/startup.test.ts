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
jest.mock('@/utils/config')

describe('startup', () => {
  it('loads no registry client or reader while the CLI loads', async () => {
    await import('@/cli')

    expect(mockClientLoaded).not.toHaveBeenCalled()
    expect(mockReaderLoaded).not.toHaveBeenCalled()
  })
})
