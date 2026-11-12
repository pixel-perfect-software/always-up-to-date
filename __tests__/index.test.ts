jest.mock('@/cli', () => {
  throw new Error(
    'boom at https://registry.example.com/SECRET-TOKEN/acme/left-pad',
  )
})

import { main } from '@/index'
import type { RegistryConfig } from '@/types'
import { trackRegistries } from '@/utils/redaction'

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

  it('reports a failure to start the CLI once, scrubbed, and exits 1', async () => {
    // Only the routes scrub() reads.
    trackRegistries(
      () =>
        ({
          registry: 'https://registry.example.com/SECRET-TOKEN/acme',
          scopedRegistries: {},
        }) as RegistryConfig,
    )

    await main()

    expect(exit).toHaveBeenCalledWith(1)
    expect(stderr).toHaveLength(1)
    expect(stderr[0]).toMatch(/^An error occurred: Error: boom at /)
    // The stack is kept: a failure to start is a bug to report.
    expect(stderr[0]).toMatch(/\n\s+at /)
    expect(stderr[0]).not.toContain('SECRET-TOKEN')
  })
})
