import { Command } from 'commander'

jest.mock('@/detectPackageManager', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue('npm'),
}))
jest.mock('@/pipeline', () => ({
  check: jest.fn(),
  findOutdated: jest.fn(),
  plan: jest.fn(),
  update: jest.fn(),
}))
jest.mock('@/utils/config')

import checkCommand from '@/commands/check'
import updateCommand from '@/commands/update'
import { check, findOutdated, plan, update } from '@/pipeline'
import type { PackageInfo, UpdateResult } from '@/types'
import logger from '@/utils/logger'
import packageJson from '../../package.json'
import { validateOutput } from '../fixtures/outputSchema'
import { reasonFor } from '../fixtures/reasons'

/**
 * The logger is real here. The fake pipeline reports progress through it the
 * way the real one does, so any human output that reaches stdout breaks
 * JSON.parse on what the command printed.
 */
const outdated: Record<string, PackageInfo> = {
  dayjs: {
    name: 'dayjs',
    current: '1.11.9',
    wanted: '1.11.9',
    latest: '1.11.23',
  },
}
const results: UpdateResult[] = [
  {
    name: 'dayjs',
    current: '1.11.9',
    wanted: '1.11.9',
    latest: '1.11.23',
    target: '1.11.23',
    updateType: 'patch',
    updated: true,
    reason: reasonFor('within range'),
  },
]

/** What `--json` prints for them. */
const rows = [
  {
    name: 'dayjs',
    workspace: '.',
    current: '1.11.9',
    wanted: '1.11.9',
    latest: '1.11.23',
    target: '1.11.23',
    updateType: 'patch',
    outcome: 'update',
    reason: { code: 'within-range', message: 'within range' },
    warnings: [],
    releaseAgeDays: null,
  },
]
const document = (command: 'check' | 'update', phase: 'plan' | 'applied') => ({
  version: 1,
  autd: packageJson.version,
  command,
  phase,
  manager: 'npm',
  member: null,
  rows,
})

const fakePipeline = {
  check: async () => {
    logger.starting('Checking dependencies', 'npm')
    logger.report(results, 'npm', 'plan')
    return outdated
  },
  update: async () => {
    logger.updatingHeader('npm', 1)
    logger.warn('Skipped ms: not listed in the root package.json.')
    return results
  },
}

const originalLog = Object.getPrototypeOf(console).log
const originalError = Object.getPrototypeOf(console).error

describe('--json output', () => {
  let program: Command
  let stdout: string[]
  let stderr: string[]

  const run = async (...args: string[]) => {
    await program.parseAsync(['node', 'autd', ...args])
    return stdout.join('\n')
  }

  beforeEach(() => {
    jest.mocked(check).mockImplementation(fakePipeline.check)
    jest.mocked(findOutdated).mockImplementation(fakePipeline.check)
    jest.mocked(update).mockImplementation(fakePipeline.update)
    jest.mocked(plan).mockResolvedValue(results)

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
    program = new Command()
    program.exitOverride()
    checkCommand(program)
    updateCommand(program)
  })

  const printedDocument = async (...args: string[]) => {
    const parsed = JSON.parse(await run(...args))
    validateOutput(parsed)
    return parsed
  }

  it('update --dry-run --json prints only the plan document on stdout', async () => {
    expect(await printedDocument('update', '--dry-run', '--json')).toEqual(
      document('update', 'plan'),
    )
  })

  it('update --json prints only the applied document on stdout', async () => {
    expect(await printedDocument('update', '--json')).toEqual(
      document('update', 'applied'),
    )
  })

  it('update --dry-run --json prints rows: [] when nothing is outdated', async () => {
    jest.mocked(findOutdated).mockImplementationOnce(async () => {
      logger.allUpToDate()
      return {}
    })

    expect(await printedDocument('update', '--dry-run', '--json')).toEqual({
      ...document('update', 'plan'),
      rows: [],
    })
  })

  it('check --json prints the rows update --dry-run --json prints', async () => {
    const checked = await printedDocument('check', '--json')
    stdout = []
    const planned = await printedDocument('update', '--dry-run', '--json')

    expect(checked).toEqual(document('check', 'plan'))
    expect(checked.rows).toEqual(planned.rows)
    expect(check).not.toHaveBeenCalled()
  })

  it('sends warnings to stderr instead of dropping them', async () => {
    await run('update', '--json')

    expect(stderr.join('\n')).toContain('Skipped ms')
  })

  it('rejects --json together with --interactive', async () => {
    await expect(run('update', '--interactive', '--json')).rejects.toThrow(
      /cannot be used with/,
    )
    expect(check).not.toHaveBeenCalled()
  })
})
