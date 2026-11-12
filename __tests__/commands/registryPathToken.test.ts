import fs from 'fs'
import path from 'path'
import reportFailure from '@/commands/reportFailure'
import { update } from '@/pipeline'
import { openProject } from '@/project'
import logger from '@/utils/logger'
import { isolateNpmConfig, prependPath, writeNodeShim } from '../fixtures'
import { tempDir } from '../fixtures/files'
import { replies, startRegistry, type TestRegistry } from '../fixtures/registry'

const TOKEN = 'SECRET-path-token'

const originalLog = Object.getPrototypeOf(console).log
const originalError = Object.getPrototypeOf(console).error

/**
 * The registry is a server on 127.0.0.1 whose path carries the token, so the
 * version manifest `plan` reads through it never leaves localhost.
 *
 * A fake `npm` on PATH fails the way npm does on a registry error, printing
 * the request URL in its stderr. That text becomes the debug line and the
 * StepError message, so a registry path token has to be scrubbed on both.
 */
describe('a registry path token in a manager', () => {
  let root: string
  let out: string[]
  let restore: Array<() => void>
  let server: TestRegistry
  let host: string

  beforeEach(async () => {
    server = await startRegistry(replies({}))
    host = `127.0.0.1:${server.port}`
    const registry = `http://${host}/${TOKEN}/acme/`
    root = tempDir('autd-redact-')
    const cwd = path.join(root, 'project')
    const bin = path.join(root, 'bin')
    fs.mkdirSync(cwd)
    fs.mkdirSync(bin)
    fs.mkdirSync(path.join(cwd, 'node_modules'))
    fs.writeFileSync(
      path.join(cwd, 'package.json'),
      JSON.stringify({ dependencies: { 'left-pad': '^1.0.0' } }),
    )
    fs.writeFileSync(path.join(cwd, '.npmrc'), `registry=${registry}\n`)
    fs.writeFileSync(
      path.join(cwd, '.always-up-to-date.json'),
      JSON.stringify({ debug: true }),
    )
    fs.writeFileSync(
      path.join(bin, 'fake-npm.js'),
      [
        `console.error(${JSON.stringify(`npm error code E404\nnpm error 404 GET ${registry}left-pad - Not found\nnpm error //${host}/${TOKEN}/acme/:_authToken`)})`,
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

  afterEach(async () => {
    await server.close()
    for (const undo of restore.reverse()) undo()
    logger.setJsonOutput(false)
    logger.configure({})
    process.exitCode = undefined
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
      reportFailure(error, { json: true, command: 'check' })
    } finally {
      project.registry.close()
    }

    const hostPattern = host.replace(/\./g, '\\.')
    const printed = out.join('\n')
    expect(printed).toContain('E404')
    expect(printed).toContain('stderr')
    expect(printed).not.toContain(TOKEN)
    expect(printed).toMatch(
      new RegExp(`http://${hostPattern}/…\\[[0-9a-f]{6}\\]/left-pad`),
    )
    expect(printed).toMatch(
      new RegExp(`//${hostPattern}/…\\[[0-9a-f]{6}\\]/:_authToken`),
    )
    // The plan's registry read reached the local server, not a host off localhost.
    expect(server.requests.map((r) => r.url)).toContain(
      `/${TOKEN}/acme/left-pad`,
    )
  })
})
