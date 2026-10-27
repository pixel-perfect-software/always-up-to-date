import fs from 'fs'
import os from 'os'
import path from 'path'
import reportFailure from '@/commands/reportFailure'
import { update } from '@/pipeline'
import { openProject } from '@/project'
import logger from '@/utils/logger'
import { isolateNpmConfig, prependPath, writeNodeShim } from '../fixtures'

const TOKEN = 'SECRET-path-token'
const REGISTRY = `https://npm-proxy.fury.io/${TOKEN}/acme/`

const originalLog = Object.getPrototypeOf(console).log
const originalError = Object.getPrototypeOf(console).error

/**
 * A fake `npm` on PATH fails the way npm does on a registry error, printing
 * the request URL in its stderr. That text becomes the debug line and the
 * StepError message, so a registry path token has to be scrubbed on both.
 */
describe('a registry path token in a manager', () => {
  let root: string
  let out: string[]
  let restore: Array<() => void>

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-redact-'))
    const cwd = path.join(root, 'project')
    const bin = path.join(root, 'bin')
    fs.mkdirSync(cwd)
    fs.mkdirSync(bin)
    fs.mkdirSync(path.join(cwd, 'node_modules'))
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }),
    )
    fs.writeFileSync(path.join(cwd, '.npmrc'), `registry=${REGISTRY}\n`)
    fs.writeFileSync(
      path.join(cwd, '.always-up-to-date.json'),
      JSON.stringify({ debug: true }),
    )
    fs.writeFileSync(
      path.join(bin, 'fake-npm.js'),
      [
        `console.error(${JSON.stringify(`npm error code E404\nnpm error 404 GET ${REGISTRY}left-pad - Not found\nnpm error //npm-proxy.fury.io/${TOKEN}/acme/:_authToken`)})`,
        'process.exit(1)',
      ].join('\n'),
    )
    writeNodeShim(bin, 'npm', 'fake-npm.js')
    restore = [prependPath(bin), isolateNpmConfig(root)]
    out = []
    console.log = originalLog
    console.error = originalError
    jest.spyOn(console, 'log').mockImplementation((...p) => {
      out.push(p.join(' '))
    })
    jest.spyOn(console, 'error').mockImplementation((...p) => {
      out.push(p.join(' '))
    })
    logger.setJsonOutput(true)
    process.exitCode = undefined
  })

  afterEach(() => {
    for (const undo of restore.reverse()) undo()
    logger.setJsonOutput(false)
    logger.configure({})
    process.exitCode = undefined
    fs.rmSync(root, { recursive: true, force: true })
  })

  it('stays out of the --json error object and the debug output', async () => {
    const project = openProject(path.join(root, 'project'), {
      pm: 'npm',
      cache: false,
    })
    try {
      await update(project, {
        discovered: {
          'left-pad': {
            name: 'left-pad',
            current: '1.0.0',
            wanted: '1.0.1',
            latest: '1.0.1',
          },
        },
      })
    } catch (error) {
      reportFailure(error, true)
    } finally {
      project.registry.close()
    }

    const printed = out.join('\n')
    expect(printed).toContain('E404')
    expect(printed).toContain('stderr')
    expect(printed).not.toContain(TOKEN)
    expect(printed).toMatch(
      /https:\/\/npm-proxy\.fury\.io\/…\[[0-9a-f]{6}\]\/left-pad/,
    )
    expect(printed).toMatch(
      /\/\/npm-proxy\.fury\.io\/…\[[0-9a-f]{6}\]\/:_authToken/,
    )
  })
})
