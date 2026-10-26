const mockClientLoaded = jest.fn()
jest.mock('@/utils/registryClient', () => {
  mockClientLoaded()
  return {}
})
jest.mock('@/utils/config')

describe('startup', () => {
  it('loads no registry client while the CLI loads', async () => {
    await import('@/cli')

    expect(mockClientLoaded).not.toHaveBeenCalled()
  })
})
