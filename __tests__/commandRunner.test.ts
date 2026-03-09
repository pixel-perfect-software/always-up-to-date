import CommandRunner from '@/commandRunner'

jest.mock('@/utils', () => ({
  execAsync: jest.fn(),
  logger: {
    command: jest.fn(),
    error: jest.fn(),
  },
}))

import { execAsync } from '@/utils'

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

  it('returns stdout from error when stderr is empty', async () => {
    const error = new Error('exit code 1') as Error & {
      stdout: string
      stderr: string
    }
    error.stdout = '{"outdated": true}'
    error.stderr = ''
    mockedExecAsync.mockRejectedValue(error)

    const result = await runner.runCommand('npm', 'outdated', '/test')

    expect(result).toBe('{"outdated": true}')
  })

  it('returns stdout from error when stderr is undefined', async () => {
    const error = new Error('exit code 1') as Error & {
      stdout: string
      stderr: undefined
    }
    error.stdout = '{"outdated": true}'
    error.stderr = undefined
    mockedExecAsync.mockRejectedValue(error)

    const result = await runner.runCommand('npm', 'outdated', '/test')

    expect(result).toBe('{"outdated": true}')
  })

  it('throws with stderr message when stderr is present', async () => {
    const error = new Error('command failed') as Error & {
      stdout: string
      stderr: string
    }
    error.stdout = ''
    error.stderr = 'npm ERR! network error'
    mockedExecAsync.mockRejectedValue(error)

    await expect(runner.runCommand('npm', 'install', '/test')).rejects.toThrow(
      'Command execution failed: npm ERR! network error',
    )
  })

  it('throws with unknown error when no stdout or stderr', async () => {
    const error = new Error('something broke')
    mockedExecAsync.mockRejectedValue(error)

    await expect(runner.runCommand('npm', 'install', '/test')).rejects.toThrow(
      'An unknown error occurred while running the command: something broke',
    )
  })
})
