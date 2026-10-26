jest.mock('@/utils/config')

import { loadConfig } from '@/utils/config'

describe('CLI', () => {
  it('reads no config while it loads', async () => {
    // --help, --version and init run without a readable config.
    await import('@/cli')

    expect(loadConfig).not.toHaveBeenCalled()
  })
})
