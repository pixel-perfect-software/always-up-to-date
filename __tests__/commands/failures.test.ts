import { Command } from 'commander'

jest.mock('@/detectPackageManager', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue('pnpm'),
}))
jest.mock('@/managers', () => ({ PackageManager: jest.fn() }))
jest.mock('@/utils/config')
jest.mock('@/utils/registry', () => ({
  clearRegistryCache: jest.fn(),
  fetchReleaseTimes: jest.fn(),
}))

import checkCommand from '@/commands/check'
import updateCommand from '@/commands/update'
import detectPackageManager from '@/detectPackageManager'
import { PackageManager } from '@/managers'
import { StepError } from '@/stepError'
import logger from '@/utils/logger'

const applyFailed = new StepError(
  'apply',
  'Command execution failed: Error: ERR_PNPM_IGNORED_BUILDS',
  { manifestWritten: true },
)
const discoverFailed = new StepError(
  'discover',
  'Command execution failed: ERR_PNPM_OUTDATED_REGISTRY_ERROR',
)

const fakeManager = {
  checkPackageVersions: jest.fn(),
  updatePackages: jest.fn(),
}

const originalLog = Object.getPrototypeOf(console).log
const originalError = Object.getPrototypeOf(console).error

describe('command failures', () => {
  let program: Command
  let stdout: string[]
  let stderr: string[]

  const run = async (...args: string[]) => {
    await program.parseAsync(['node', 'autd', ...args])
    return stdout.join('\n')
  }

  beforeEach(() => {
    jest
      .mocked(PackageManager)
      .mockImplementation(
        () =>
          ({ manager: fakeManager }) as unknown as InstanceType<
            typeof PackageManager
          >,
      )
    fakeManager.checkPackageVersions.mockReset()
    fakeManager.updatePackages.mockReset()

    stdout = []
    stderr = []
    console.log = originalLog
    console.error = originalError
    jest
      .spyOn(console, 'log')
      .mockImplementation((...parts) => stdout.push(parts.join(' ')))
    jest
      .spyOn(console, 'error')
      .mockImplementation((...parts) => stderr.push(parts.join(' ')))

    logger.setJsonOutput(false)
    process.exitCode = undefined
    program = new Command()
    program.exitOverride()
    checkCommand(program)
    updateCommand(program)
  })

  afterEach(() => {
    process.exitCode = undefined
  })

  it('update exits 1 and names the failed step and the written manifest', async () => {
    fakeManager.updatePackages.mockRejectedValue(applyFailed)

    const output = await run('update', 'dayjs')

    expect(process.exitCode).toBe(1)
    expect(output).toContain('Failed during apply')
    expect(output).toContain('ERR_PNPM_IGNORED_BUILDS')
    expect(output).toContain('package.json was already rewritten')
  })

  it('update --json exits 1 and prints a JSON error object instead of []', async () => {
    fakeManager.updatePackages.mockRejectedValue(applyFailed)

    const output = await run('update', '--json', 'dayjs')

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output)).toEqual({
      error: {
        step: 'apply',
        message: 'Command execution failed: Error: ERR_PNPM_IGNORED_BUILDS',
        manifestWritten: true,
      },
    })
  })

  it('update --dry-run --json reports a discovery failure as JSON', async () => {
    fakeManager.checkPackageVersions.mockRejectedValue(discoverFailed)

    const output = await run('update', '--dry-run', '--json')

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output).error).toMatchObject({
      step: 'discover',
      manifestWritten: false,
    })
  })

  it('check --json reports a discovery failure as JSON', async () => {
    fakeManager.checkPackageVersions.mockRejectedValue(discoverFailed)

    const output = await run('check', '--json')

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output).error.step).toBe('discover')
  })

  it('check reports a missing package manager as a detect failure', async () => {
    // The real detector, pointed at a directory with no lockfile.
    jest
      .mocked(detectPackageManager)
      .mockImplementationOnce(() =>
        jest.requireActual('@/detectPackageManager').default(__dirname),
      )

    const output = await run('check', '--json')

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output).error).toMatchObject({
      step: 'detect',
      message: 'No package manager detected in the current directory.',
    })
  })

  it('leaves the exit code alone when the update succeeds', async () => {
    fakeManager.updatePackages.mockResolvedValue([])

    await run('update', '--json')

    expect(process.exitCode).toBeUndefined()
  })
})
