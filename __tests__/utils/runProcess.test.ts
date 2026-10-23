import fs from 'fs'
import os from 'os'
import path from 'path'
import { buildWindowsCommand, runProcess } from '@/utils/runProcess'

// Real child processes: `node` itself stands in for a package manager.
const posixIt = process.platform === 'win32' ? it.skip : it

describe('runProcess', () => {
  let cwd: string

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-run-process-'))
  })

  afterEach(() => {
    fs.rmSync(cwd, { recursive: true, force: true })
  })

  it('returns more than 1 MB of stdout without a buffer cap', async () => {
    const size = 1.5 * 1024 * 1024

    const { stdout } = await runProcess(
      'node',
      ['-e', `process.stdout.write('x'.repeat(${size}))`],
      { cwd },
    )

    expect(stdout).toHaveLength(size)
  })

  posixIt('passes arguments verbatim, with no shell in between', async () => {
    const args = ['react@>=19.0.0', 'dayjs@^1.11.23', '$(touch pwned)', '*']

    const { stdout } = await runProcess(
      'node',
      ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', ...args],
      { cwd },
    )

    expect(JSON.parse(stdout)).toEqual(args)
    expect(fs.readdirSync(cwd)).toEqual([])
  })

  it('rejects with the exit code and both streams on a non-zero exit', async () => {
    await expect(
      runProcess(
        'node',
        [
          '-e',
          "process.stdout.write('out'); process.stderr.write('err'); process.exit(3)",
        ],
        { cwd },
      ),
    ).rejects.toMatchObject({ code: 3, stdout: 'out', stderr: 'err' })
  })
})

describe('buildWindowsCommand', () => {
  it('double-quotes arguments that hold cmd.exe operators', () => {
    expect(
      buildWindowsCommand('yarn', [
        'upgrade',
        'dayjs@^1.11.23',
        'react@>=19.0.0',
        'ms@2.1.3',
      ]),
    ).toBe('yarn upgrade "dayjs@^1.11.23" "react@>=19.0.0" ms@2.1.3')
  })
})
