jest.mock('@/cli', () => {
  throw new Error('boom')
})

import { main } from '@/index'

const originalError = Object.getPrototypeOf(console).error

describe('CLI entry', () => {
  let stderr: string[]
  let exit: jest.SpyInstance

  beforeEach(() => {
    stderr = []
    console.error = originalError
    jest
      .spyOn(console, 'error')
      .mockImplementation((...parts) => stderr.push(parts.join(' ')))
    exit = jest
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined as never)
  })

  it('reports a failure to start the CLI and exits 1', async () => {
    await main()

    expect(exit).toHaveBeenCalledWith(1)
    expect(stderr).toEqual(['An error occurred: Error: boom'])
  })
})
