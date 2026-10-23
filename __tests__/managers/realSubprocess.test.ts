import fs from 'fs'
import os from 'os'
import path from 'path'
import npm from '@/managers/npm'
import { check, update } from '@/pipeline'
import { projectFor } from '../fixtures'

jest.mock('@/utils/logger')
jest.mock('@/utils/registry', () => ({
  clearRegistryCache: jest.fn(),
  fetchReleaseTimes: jest.fn(),
}))

/**
 * These tests spawn a real process: a fake `npm` placed first on PATH that
 * records its arguments and prints a canned `outdated --json` report, exiting
 * 1 like the real one. Nothing in the exec path is mocked.
 */
const posixIt = process.platform === 'win32' ? it.skip : it

describe('npm with a real subprocess', () => {
  let root: string
  let cwd: string
  let argvLog: string
  let reportFile: string
  const originalPath = process.env.PATH

  const writeReport = (report: Record<string, unknown>) =>
    fs.writeFileSync(reportFile, JSON.stringify(report, null, 2))

  const loggedCalls = (): string[][] =>
    fs
      .readFileSync(argvLog, 'utf8')
      .split('\n--\n')
      .filter(Boolean)
      .map((call) => call.split('\n'))

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-subprocess-'))
    cwd = path.join(root, 'project')
    const bin = path.join(root, 'bin')
    fs.mkdirSync(cwd)
    fs.mkdirSync(bin)
    argvLog = path.join(root, 'argv.log')
    reportFile = path.join(root, 'report.json')
    fs.writeFileSync(argvLog, '')

    const fakeNpm = path.join(bin, 'npm')
    fs.writeFileSync(
      fakeNpm,
      [
        '#!/bin/sh',
        `for arg in "$@"; do printf '%s\\n' "$arg" >> '${argvLog}'; done`,
        `printf -- '--\\n' >> '${argvLog}'`,
        `if [ "$1" = outdated ]; then cat '${reportFile}'; exit 1; fi`,
        'exit 0',
      ].join('\n'),
    )
    fs.chmodSync(fakeNpm, 0o755)
    process.env.PATH = `${bin}${path.delimiter}${originalPath}`
  })

  afterEach(() => {
    process.env.PATH = originalPath
    fs.rmSync(root, { recursive: true, force: true })
  })

  posixIt('reads more than 1 MB of outdated output', async () => {
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

  posixIt(
    'passes package names as arguments, never through a shell',
    async () => {
      const name = 'left-pad;touch pwned'
      fs.writeFileSync(
        path.join(cwd, 'package.json'),
        JSON.stringify({ dependencies: { [name]: '^1.0.0' } }),
      )
      writeReport({
        [name]: { current: '1.0.0', wanted: '1.0.1', latest: '1.0.1' },
      })

      await update(projectFor(npm, cwd))

      expect(loggedCalls()).toEqual([
        ['outdated', '--json'],
        ['update', name],
      ])
      expect(fs.existsSync(path.join(cwd, 'pwned'))).toBe(false)
    },
  )
})
