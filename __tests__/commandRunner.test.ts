import CommandRunner from '@/commandRunner'
import { exitError } from './fixtures'

jest.mock('@/utils', () => ({
  execAsync: jest.fn(),
  logger: {
    command: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
  },
}))

import { execAsync, logger } from '@/utils'

const mockedExecAsync = jest.mocked(execAsync)

describe('CommandRunner', () => {
  let runner: CommandRunner

  beforeEach(() => {
    runner = new CommandRunner()
  })

  it('returns stdout on successful command', async () => {
    mockedExecAsync.mockResolvedValue({
      stdout: '{"react": "19.0.0"}',
      stderr: '',
    })

    const result = await runner.runCommand('npm', 'outdated --json', '/test')

    expect(result).toBe('{"react": "19.0.0"}')
    expect(mockedExecAsync).toHaveBeenCalledWith('npm outdated --json', {
      cwd: '/test',
      encoding: 'utf8',
    })
  })

  it('logs stderr at debug level instead of failing on exit 0', async () => {
    mockedExecAsync.mockResolvedValue({
      stdout: 'done',
      stderr: 'npm warn deprecated inflight@1.0.6',
    })

    const result = await runner.runCommand('npm', 'update react', '/test')

    expect(result).toBe('done')
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('npm warn deprecated inflight@1.0.6'),
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('rejects a non-zero exit by default, even with stdout and no stderr', async () => {
    mockedExecAsync.mockRejectedValue(exitError(1, 'partial output', ''))

    await expect(runner.runCommand('npm', 'install', '/test')).rejects.toThrow(
      'Command execution failed: partial output',
    )
  })

  it('returns stdout for a non-zero exit the success check accepts', async () => {
    mockedExecAsync.mockRejectedValue(
      exitError(1, '{"outdated": true}', '(node:1) [DEP0169] Warning'),
    )
    const isSuccess = jest.fn().mockReturnValue(true)

    const result = await runner.runCommand(
      'yarn',
      'outdated --json',
      '/test',
      isSuccess,
    )

    expect(result).toBe('{"outdated": true}')
    expect(isSuccess).toHaveBeenCalledWith({
      exitCode: 1,
      stdout: '{"outdated": true}',
    })
    expect(logger.debug).toHaveBeenCalledWith(
      expect.stringContaining('[DEP0169] Warning'),
    )
    expect(logger.error).not.toHaveBeenCalled()
  })

  it('throws with stderr message when the success check rejects the exit', async () => {
    mockedExecAsync.mockRejectedValue(
      exitError(1, '', 'npm ERR! network error'),
    )

    await expect(
      runner.runCommand('npm', 'install', '/test', () => false),
    ).rejects.toThrow('Command execution failed: npm ERR! network error')
  })

  it('throws with unknown error when the process never exited with a code', async () => {
    const error = new Error('something broke')
    mockedExecAsync.mockRejectedValue(error)

    await expect(runner.runCommand('npm', 'install', '/test')).rejects.toThrow(
      'An unknown error occurred while running the command: something broke',
    )
  })
})
