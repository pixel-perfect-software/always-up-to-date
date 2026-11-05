const mockLoaded = jest.fn()

/** A mock factory that records the load and hands back the real module. */
function mockTracked(name: string): unknown {
  mockLoaded(name)
  return jest.requireActual(name)
}

// The registry client, reader and cache load when a lookup needs them.
jest.mock('@/utils/registryClient', () => {
  mockLoaded('@/utils/registryClient')
  return {}
})
jest.mock('@/utils/registryReader', () => {
  mockLoaded('@/utils/registryReader')
  return {}
})
jest.mock('@/utils/registryCache', () => {
  mockLoaded('@/utils/registryCache')
  return {}
})

// Everything a command's action needs loads when the action runs, not with the CLI.
jest.mock('@/commands/actions/check', () =>
  mockTracked('@/commands/actions/check'),
)
jest.mock('@/commands/actions/update', () =>
  mockTracked('@/commands/actions/update'),
)
jest.mock('@/commands/actions/init', () =>
  mockTracked('@/commands/actions/init'),
)
jest.mock('@/commands/actions/help', () =>
  mockTracked('@/commands/actions/help'),
)
jest.mock('@/pipeline', () => mockTracked('@/pipeline'))
jest.mock('@/project', () => mockTracked('@/project'))
jest.mock('@/managers', () => mockTracked('@/managers'))
jest.mock('@/detectPackageManager', () => mockTracked('@/detectPackageManager'))
jest.mock('@/utils', () => mockTracked('@/utils'))
jest.mock('@/utils/logger', () => mockTracked('@/utils/logger'))
jest.mock('@/utils/config', () => mockTracked('@/utils/config'))
jest.mock('semver', () => mockTracked('semver'))
jest.mock('colorette', () => mockTracked('colorette'))
jest.mock('@inquirer/prompts', () => mockTracked('@inquirer/prompts'))

describe('startup', () => {
  it('loads none of the actions, the pipeline or their dependencies with the CLI', async () => {
    await import('@/cli')

    expect(mockLoaded.mock.calls.flat()).toEqual([])
  })
})
