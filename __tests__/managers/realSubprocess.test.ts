import fs from 'fs'
import os from 'os'
import path from 'path'
import npm from '@/managers/npm'
import { update } from '@/pipeline'
import type { PackageInfo } from '@/types'
import { prependPath, projectFor, writeNodeShim } from '../fixtures'

jest.mock('@/utils/logger')

/**
 * These tests spawn a real process: a fake `npm` placed first on PATH that
 * records its arguments and, for `update`, prints more than 1 MB. Nothing in
 * the exec path is mocked. On Windows the call goes through cmd.exe and a
 * cmd-shim `npm.cmd` re-reading `%*`, as with the real npm.
 */
describe('npm with a real subprocess', () => {
  let root: string
  let cwd: string
  let argvLog: string
  let restorePath: () => void

  const discovered = (names: string[]): Record<string, PackageInfo> =>
    Object.fromEntries(
      names.map((name) => [
        name,
        { name, current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
      ]),
    )

  const loggedCalls = (): string[][] =>
    fs
      .readFileSync(argvLog, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as string[])

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-subprocess-'))
    cwd = path.join(root, 'project')
    const bin = path.join(root, 'bin')
    fs.mkdirSync(cwd)
    fs.mkdirSync(bin)
    argvLog = path.join(root, 'argv.log')
    fs.writeFileSync(argvLog, '')

    // Written to stdout whole, then a natural exit: the 1.5 MB must flush first.
    fs.writeFileSync(
      path.join(bin, 'fake-npm.js'),
      [
        "const fs = require('fs')",
        'const args = process.argv.slice(2)',
        `fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + '\\n')`,
        "if (args[0] === 'update') {",
        "  process.stdout.write('x'.repeat(1.5 * 1024 * 1024))",
        '}',
      ].join('\n'),
    )
    writeNodeShim(bin, 'npm', 'fake-npm.js')
    restorePath = prependPath(bin)
  })

  afterEach(() => {
    restorePath()
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('gets past more than 1 MB of update output', async () => {
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { 'package-0': '^1.0.0' } }),
    )

    const results = await update(projectFor(npm, cwd), {
      discovered: discovered(['package-0']),
    })

    expect(results).toEqual([
      expect.objectContaining({ name: 'package-0', updated: true }),
    ])
    expect(loggedCalls()).toEqual([['update', 'package-0']])
  })

  it('passes package names as arguments, never as commands', async () => {
    // One name per shell: `;` ends a command in sh, `&` in cmd.exe.
    const names = ['left-pad;touch pwned', 'right-pad&echo pwned>pwned']
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({
        dependencies: Object.fromEntries(names.map((n) => [n, '^1.0.0'])),
      }),
    )

    await update(projectFor(npm, cwd), { discovered: discovered(names) })

    expect(loggedCalls()).toEqual([['update', ...names]])
    expect(fs.existsSync(path.join(cwd, 'pwned'))).toBe(false)
  })
})
