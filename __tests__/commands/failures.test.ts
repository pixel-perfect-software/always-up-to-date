import { Command } from 'commander'

jest.mock('@/detectPackageManager', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue('pnpm'),
}))
jest.mock('@/pipeline', () => ({
  check: jest.fn(),
  plan: jest.fn(),
  update: jest.fn(),
}))
jest.mock('@/utils/config')
jest.mock('@/utils/registry', () => ({
  createRegistrySession: jest.fn(),
}))

import checkCommand from '@/commands/check'
import updateCommand from '@/commands/update'
import detectPackageManager from '@/detectPackageManager'
import { check, update } from '@/pipeline'
import { StepError } from '@/stepError'
import { loadConfig } from '@/utils/config'
import logger from '@/utils/logger'
import { createRegistrySession } from '@/utils/registry'
import { fakeRegistry } from '../fixtures'

const applyFailed = new StepError(
  'apply',
  'Command execution failed: Error: ERR_PNPM_IGNORED_BUILDS',
  { manifestWritten: true },
)
const discoverFailed = new StepError(
  'discover',
  'Command execution failed: ERR_PNPM_OUTDATED_REGISTRY_ERROR',
)

const configFailed = new (jest.requireActual('@/utils/config').ConfigError)(
  'Failed to load JSON config from /project/.always-up-to-date.json: rules["react"] must be one of "hold", "followRange", "latest" (got "hodl")',
)

const pipeline = {
  check: jest.mocked(check),
  update: jest.mocked(update),
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
    pipeline.check.mockReset()
    pipeline.update.mockReset()
    jest.mocked(createRegistrySession).mockReturnValue(fakeRegistry())

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
    pipeline.update.mockRejectedValue(applyFailed)

    const output = await run('update', 'dayjs')

    expect(process.exitCode).toBe(1)
    expect(output).toContain('Failed during apply')
    expect(output).toContain('ERR_PNPM_IGNORED_BUILDS')
    expect(output).toContain('package.json was already rewritten')
  })

  it('update --json exits 1 and prints a JSON error object instead of []', async () => {
    pipeline.update.mockRejectedValue(applyFailed)

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
    pipeline.check.mockRejectedValue(discoverFailed)

    const output = await run('update', '--dry-run', '--json')

    expect(process.exitCode).toBe(1)
    expect(JSON.parse(output).error).toMatchObject({
      step: 'discover',
      manifestWritten: false,
    })
  })

  it('check --json reports a discovery failure as JSON', async () => {
    pipeline.check.mockRejectedValue(discoverFailed)

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
      message: expect.stringContaining(
        'No package manager detected in the current directory',
      ),
    })
  })

  it.each([['check'], ['update']])(
    '%s reports a malformed config once and exits 1',
    async (command) => {
      jest.mocked(loadConfig).mockImplementationOnce(() => {
        throw configFailed
      })

      const output = await run(command)

      expect(process.exitCode).toBe(1)
      expect(output).toContain(configFailed.message)
      expect(stdout.filter((line) => line.includes('❌'))).toHaveLength(1)
      expect(pipeline.check).not.toHaveBeenCalled()
      expect(pipeline.update).not.toHaveBeenCalled()
    },
  )

  it.each([
    ['check', '--json'],
    ['update', '--json'],
  ])(
    '%s --json prints a malformed config as the JSON error object',
    async (...args) => {
      jest.mocked(loadConfig).mockImplementationOnce(() => {
        throw configFailed
      })

      const output = await run(...args)

      expect(process.exitCode).toBe(1)
      expect(JSON.parse(output)).toEqual({
        error: { message: configFailed.message, manifestWritten: false },
      })
      expect(stdout).toHaveLength(1)
    },
  )

  it.each([
    ['check', 'failed'],
    ['update', 'failed'],
    ['check', 'successful'],
    ['update', 'successful'],
  ] as const)(
    "%s closes the run's registry session after a %s command",
    async (command, outcome) => {
      const close = jest.fn()
      jest
        .mocked(createRegistrySession)
        .mockReturnValue(fakeRegistry({ close }))
      if (outcome === 'failed') {
        pipeline[command].mockRejectedValue(discoverFailed)
      } else if (command === 'check') {
        pipeline.check.mockResolvedValue({})
      } else {
        pipeline.update.mockResolvedValue([])
      }

      await run(command)

      expect(close).toHaveBeenCalledTimes(1)
    },
  )

  it('leaves the exit code alone when the update succeeds', async () => {
    pipeline.update.mockResolvedValue([])

    await run('update', '--json')

    expect(process.exitCode).toBeUndefined()
  })
})
