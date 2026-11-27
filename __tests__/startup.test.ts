import { describe, expect, fn, it, mock, requireActual } from 'provino'

const mockLoaded = fn()

/** A mock factory that records the load and hands back the real module. */
function mockTracked(name: string): Record<string, unknown> {
  mockLoaded(name)
  return requireActual<Record<string, unknown>>(name)
}

// The registry client, reader and cache load when a lookup needs them.
mock('@/utils/registryClient', () => {
  mockLoaded('@/utils/registryClient')
  return {}
})
mock('@/utils/registryReader', () => {
  mockLoaded('@/utils/registryReader')
  return {}
})
mock('@/utils/registryCache', () => {
  mockLoaded('@/utils/registryCache')
  return {}
})

// Everything a command's action needs loads when the action runs, not with the CLI.
mock('@/commands/actions/check', () => mockTracked('@/commands/actions/check'))
mock('@/commands/actions/update', () =>
  mockTracked('@/commands/actions/update'),
)
mock('@/commands/actions/init', () => mockTracked('@/commands/actions/init'))
mock('@/pipeline', () => mockTracked('@/pipeline'))
mock('@/project', () => mockTracked('@/project'))
mock('@/managers', () => mockTracked('@/managers'))
mock('@/detectPackageManager', () => mockTracked('@/detectPackageManager'))
mock('@/utils/logger', () => mockTracked('@/utils/logger'))
mock('@/utils/config', () => mockTracked('@/utils/config'))
mock('semver', () => mockTracked('semver'))
mock('colorette', () => mockTracked('colorette'))
mock('@inquirer/prompts', () => mockTracked('@inquirer/prompts'))

describe('startup', () => {
  it('loads none of the actions, the pipeline or their dependencies with the CLI', async () => {
    await import('@/cli')

    expect(mockLoaded.mock.calls.flat()).toEqual([])
  })
})
