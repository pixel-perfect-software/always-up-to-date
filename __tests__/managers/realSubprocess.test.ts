import fs from 'fs'
import os from 'os'
import path from 'path'
import npm from '@/managers/npm'
import { check, update } from '@/pipeline'
import { prependPath, projectFor, writeNodeShim } from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils/registry', () => ({
  clearRegistryCache: jest.fn(),
  fetchReleaseTimes: jest.fn(),
}))

/**
 * These tests spawn a real process: a fake `npm` placed first on PATH that
 * records its arguments and prints a canned `outdated --json` report, exiting
 * 1 like the real one. Nothing in the exec path is mocked. On Windows the
 * call goes through cmd.exe and a cmd-shim `npm.cmd` re-reading `%*`, as with
 * the real npm.
 */
describe('npm with a real subprocess', () => {
  let root: string
  let cwd: string
  let argvLog: string
  let reportFile: string
  let restorePath: () => void

  const writeReport = (report: Record<string, unknown>) =>
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))

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
    reportFile = path.join(root, 'report.json')
    fs.writeFileSync(argvLog, '')

    // process.exitCode, not process.exit: the 1.5 MB report must flush first.
    fs.writeFileSync(
      path.join(bin, 'fake-npm.js'),
      [
        "const fs = require('fs')",
        'const args = process.argv.slice(2)',
        `fs.appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(args) + '\\n')`,
        "if (args[0] === 'outdated') {",
        `  process.stdout.write(fs.readFileSync(${JSON.stringify(reportFile)}))`,
        '  process.exitCode = 1',
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

  it('reads more than 1 MB of outdated output', async () => {
    const report: Record<string, unknown> = {}
    for (let i = 0; i < 10000; i++) {
      report[`package-${i}`] = {
        current: '1.0.0',
        wanted: '1.0.0',
        latest: '1.0.1',
        dependent: 'project',
        location: `/project/node_modules/package-${i}`,
      }
    }
    writeReport(report)
    expect(fs.statSync(reportFile).size).toBeGreaterThan(1.5 * 1024 * 1024)

    const result = await check(projectFor(npm, cwd))

    expect(Object.keys(result)).toHaveLength(10000)
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
    writeReport(
      Object.fromEntries(
        names.map((n) => [
          n,
          { current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
        ]),
      ),
    )

    await update(projectFor(npm, cwd))

    expect(loggedCalls()).toEqual([
      ['outdated', '--json'],
      ['update', ...names],
    ])
    expect(fs.existsSync(path.join(cwd, 'pwned'))).toBe(false)
  })
})
