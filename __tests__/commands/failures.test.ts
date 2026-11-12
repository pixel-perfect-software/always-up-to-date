import { Command } from 'commander'

jest.mock('@/detectPackageManager', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue('pnpm'),
}))
jest.mock('@/pipeline', () => ({
  check: jest.fn(),
  findOutdated: jest.fn(),
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
import { check, findOutdated, update } from '@/pipeline'
import { StepError } from '@/stepError'
import { loadConfig } from '@/utils/config'
import logger from '@/utils/logger'
import { createRegistrySession } from '@/utils/registry'
import packageJson from '../../package.json'
import { fakeRegistry } from '../fixtures'
import { validateOutput } from '../fixtures/outputSchema'

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
  findOutdated: jest.mocked(findOutdated),
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

  /** Everything a human-mode run printed, either stream: which stream is #223's to test. */
  const printed = () => [...stdout, ...stderr].join('\n')

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

    await run('update', 'dayjs')
    const output = stderr.join('\n')

    expect(process.exitCode).toBe(1)
    expect(output).toContain('Failed during apply')
    expect(output).toContain('ERR_PNPM_IGNORED_BUILDS')
    expect(output).toContain('package.json was already rewritten')
    expect(stdout.join('\n')).not.toContain('Failed during apply')
  })

  it.each([['check'], ['update']] as const)(
    '%s with silent: true still prints the failure, and the rewritten-manifest note',
    async (command) => {
      jest
        .mocked(loadConfig)
        .mockImplementation(
          () => ({ silent: true }) as ReturnType<typeof loadConfig>,
        )
      pipeline[command].mockRejectedValue(applyFailed)

      await run(command)

      expect(process.exitCode).toBe(1)
      const output = stderr.join('\n')
      expect(output).toContain('Failed during apply')
      expect(output).toContain('ERR_PNPM_IGNORED_BUILDS')
      expect(output).toContain('package.json was already rewritten')
      expect(stdout).toHaveLength(0)
    },
  )

  it('update --json exits 1 and prints a JSON error object instead of []', async () => {
    pipeline.update.mockRejectedValue(applyFailed)

    const output = await run('update', '--json', 'dayjs')

    expect(process.exitCode).toBe(1)
    validateOutput(JSON.parse(output))
    expect(JSON.parse(output)).toEqual({
      version: 1,
      autd: packageJson.version,
      command: 'update',
      error: {
        step: 'apply',
        message: 'Command execution failed: Error: ERR_PNPM_IGNORED_BUILDS',
        manifestWritten: true,
      },
    })
  })

  it('update --dry-run --json reports a discovery failure as JSON', async () => {
    pipeline.findOutdated.mockRejectedValue(discoverFailed)

    const output = await run('update', '--dry-run', '--json')

    expect(process.exitCode).toBe(1)
    validateOutput(JSON.parse(output))
    expect(JSON.parse(output).error).toMatchObject({
      step: 'discover',
      manifestWritten: false,
    })
  })

  it('check --json reports a discovery failure as JSON', async () => {
    pipeline.findOutdated.mockRejectedValue(discoverFailed)

    const output = await run('check', '--json')

    expect(process.exitCode).toBe(1)
    validateOutput(JSON.parse(output))
    expect(JSON.parse(output)).toMatchObject({
      command: 'check',
      error: { step: 'discover' },
    })
  })

  it('update names a target that is not a dependency, with --json too (#222)', async () => {
    const unknown = new StepError(
      'discover',
      "leftpad-nope isn't a dependency of this project",
    )
    pipeline.findOutdated.mockRejectedValue(unknown)

    await run('update', 'leftpad-nope', '--dry-run')
    const human = printed()
    expect(process.exitCode).toBe(1)
    expect(human).toContain(
      "Failed during discover: leftpad-nope isn't a dependency of this project",
    )
    expect(pipeline.findOutdated).toHaveBeenCalledWith(expect.anything(), [
      'leftpad-nope',
    ])

    stdout.length = 0
    stderr.length = 0
    process.exitCode = undefined
    const output = await run('update', 'leftpad-nope', '--dry-run', '--json')
    expect(process.exitCode).toBe(1)
    validateOutput(JSON.parse(output))
    expect(JSON.parse(output).error).toEqual({
      step: 'discover',
      message: "leftpad-nope isn't a dependency of this project",
      manifestWritten: false,
    })
  })

  it('prints a refusal without the Failed during prefix, and keeps its step in JSON (#222)', async () => {
    const refused = new StepError('apply', 'autd update runs from the root', {
      refusal: true,
    })
    pipeline.update.mockRejectedValue(refused)

    await run('update')
    const human = printed()
    expect(human).toContain('autd update runs from the root')
    expect(human).not.toContain('Failed during')

    stdout.length = 0
    const output = await run('update', '--json')
    expect(JSON.parse(output).error).toMatchObject({
      step: 'apply',
      message: 'autd update runs from the root',
    })
  })

  describe('update -i (#222)', () => {
    const tty = process.stdin.isTTY
    afterEach(() => {
      process.stdin.isTTY = tty
    })

    it.each([
      [['update', '-i', 'react'], true, "can't be combined with package names"],
      [['update', '-i', '--dry-run'], true, "can't be combined with --dry-run"],
      [['update', '-i'], false, 'needs a terminal'],
    ])('refuses %j before opening anything', async (args, isTTY, text) => {
      process.stdin.isTTY = isTTY

      await run(...args)
      const output = printed()

      expect(process.exitCode).toBe(1)
      expect(output).toContain(text)
      expect(output).not.toContain('Failed during')
      expect(pipeline.findOutdated).not.toHaveBeenCalled()
      expect(pipeline.update).not.toHaveBeenCalled()
      expect(createRegistrySession).not.toHaveBeenCalled()
    })

    it('points a terminal-less -i at the named and dry-run forms', async () => {
      process.stdin.isTTY = false

      await run('update', '-i')
      const output = printed()

      expect(output).toContain('autd update [packages…]')
      expect(output).toContain('autd update --dry-run')
    })
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
    validateOutput(JSON.parse(output))
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

      await run(command)
      const output = stderr.join('\n')

      expect(process.exitCode).toBe(1)
      expect(output).toContain(configFailed.message)
      expect(stderr.filter((line) => line.includes('❌'))).toHaveLength(1)
      expect(stdout.filter((line) => line.includes('❌'))).toHaveLength(0)
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
      validateOutput(JSON.parse(output))
      expect(JSON.parse(output)).toEqual({
        version: 1,
        autd: packageJson.version,
        command: args[0],
        error: {
          step: null,
          message: configFailed.message,
          manifestWritten: false,
        },
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
