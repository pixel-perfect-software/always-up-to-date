import { Command } from 'commander'

jest.mock('@/detectPackageManager', () => ({
  __esModule: true,
  default: jest.fn().mockReturnValue('npm'),
}))
jest.mock('@/pipeline', () => ({
  check: jest.fn(),
  plan: jest.fn(),
  update: jest.fn(),
}))
jest.mock('@/utils/config')
jest.mock('@/utils/registry', () => ({
  clearRegistryCache: jest.fn(),
  fetchReleaseTimes: jest.fn(),
}))

import checkCommand from '@/commands/check'
import updateCommand from '@/commands/update'
import { check, plan, update } from '@/pipeline'
import type { PackageInfo, UpdateResult } from '@/types'
import logger from '@/utils/logger'

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
    updateType: 'patch',
    updated: true,
  },
]

const fakePipeline = {
  check: async () => {
    logger.starting('Checking dependencies', 'npm')
    logger.outdatedHeader()
    logger.printOutdatedRows([
      { name: 'dayjs', current: '1.11.9', latest: '1.11.23' },
    ])
    return outdated
  },
  update: async () => {
    logger.updatingHeader('npm')
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

  it('update --dry-run --json prints only JSON on stdout', async () => {
    expect(JSON.parse(await run('update', '--dry-run', '--json'))).toEqual(
      results,
    )
  })

  it('update --json prints only JSON on stdout', async () => {
    expect(JSON.parse(await run('update', '--json'))).toEqual(results)
  })

  it('update --dry-run --json prints [] when nothing is outdated', async () => {
    jest.mocked(check).mockImplementationOnce(async () => {
      logger.allUpToDate()
      return {}
    })

    expect(JSON.parse(await run('update', '--dry-run', '--json'))).toEqual([])
  })

  it('check --json prints only JSON on stdout', async () => {
    expect(JSON.parse(await run('check', '--json'))).toEqual(outdated)
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
