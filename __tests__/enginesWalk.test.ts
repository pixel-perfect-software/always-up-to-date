jest.mock('@/utils/logger')
jest.mock('@/utils/engines', () => ({
  ...jest.requireActual('@/utils/engines'),
  runningNode: () => '12.22.12',
}))

import fs from 'fs'
import os from 'os'
import path from 'path'
import { findOutdated, plan } from '@/pipeline'
import { openProject, type Project } from '@/project'
import { isolateNpmConfig } from './fixtures'
import { reasonFor } from './fixtures/reasons'
import {
  derive,
  type Reply,
  registryBody,
  replies,
  startRegistry,
  type TestRegistry,
} from './fixtures/registry'

// #200: npm installs the newest version its Node runs, so the plan walks a
// target that excludes the running Node (12.22.12 here) down to the version
// npm would install. Through the real session, reader and disk cache, from a
// local registry serving the typescript manifest captures. The packument is
// the deps.dev capture's version list, cut to the six versions around the
// range and reshaped by `derive`: no packument of typescript is committed.

const LISTED = ['5.0.2', '5.0.3', '5.0.4', '5.1.3', '5.1.5', '5.1.6']
const packument: Reply = {
  type: 'application/vnd.npm.install-v1+json',
  body: derive<Record<string, unknown>>('typescript.deps-dev', (body) => {
    const versions = (body.versions as { versionKey: { version: string } }[])
      .map((entry) => entry.versionKey.version)
      .filter((version) => LISTED.includes(version))
    for (const key of Object.keys(body)) delete body[key]
    body.name = 'typescript'
    body['dist-tags'] = { latest: '5.1.6' }
    body.versions = Object.fromEntries(
      versions.map((version) => [version, { name: 'typescript', version }]),
    )
  }),
}
const manifest = (version: string): Reply => ({
  body: registryBody(`typescript.${version}.manifest`),
})

const isManifestUrl = (url: string): boolean =>
  /^\/typescript\/[^/]+$/.test(url)

let tmp: string
const at = (...parts: string[]) => path.join(tmp, ...parts)
const write = (file: string, content: string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content)
}

describe('npm engines walk-back, end to end (#200)', () => {
  let server: TestRegistry
  let saved: NodeJS.ProcessEnv
  let restoreNpm: () => void
  const projects: Project[] = []

  beforeEach(async () => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'autd-engines-walk-')),
    )
    saved = { ...process.env }
    restoreNpm = isolateNpmConfig(at('npm-config'))
    process.env.XDG_CONFIG_HOME = at('xdg')
    delete process.env.AUTD_NO_CACHE
    process.env.AUTD_CACHE_DIR = at('cache')
    server = await startRegistry(
      replies({
        '/typescript': packument,
        '/typescript/5.1.6': manifest('5.1.6'),
        '/typescript/5.1.5': manifest('5.1.5'),
        '/typescript/5.1.3': manifest('5.1.3'),
        '/typescript/5.0.4': manifest('5.0.4'),
      }),
    )
    write(at('.npmrc'), `registry=${server.url}\n`)
    write(
      at('package.json'),
      JSON.stringify({
        name: 'p',
        dependencies: { typescript: '>=5.0.0 <5.2.0' },
      }),
    )
    // Installed at 5.0.2: the 5.1.6 capture with its version replaced, so the
    // license pass finds the installed license without a request.
    write(
      at('node_modules', 'typescript', 'package.json'),
      derive('typescript.5.1.6.manifest', (body: { version: string }) => {
        body.version = '5.0.2'
      }),
    )
  })
  afterEach(async () => {
    for (const project of projects.splice(0)) project.registry.close()
    await server.close()
    restoreNpm()
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  const open = (pm: 'npm' | 'pnpm' = 'npm') => {
    write(at('.always-up-to-date.json'), JSON.stringify({}))
    const project = openProject(tmp, { pm })
    projects.push(project)
    return project
  }
  const manifestRequests = () =>
    server.requests.map((r) => r.url).filter(isManifestUrl)

  it('plans 5.0.4 with four manifest requests, and none from a second session on the same cache', async () => {
    const first = open()
    const outdated = await findOutdated(first)

    const [result] = await plan(first, outdated)

    expect(result).toMatchObject({
      name: 'typescript',
      updated: true,
      target: '5.0.4',
      wanted: '5.1.6',
      reason: reasonFor(
        'engines: 5.1.6 needs node >=14.17 (running node 12.22.12)',
      ),
    })
    expect(manifestRequests().sort()).toEqual([
      '/typescript/5.0.4',
      '/typescript/5.1.3',
      '/typescript/5.1.5',
      '/typescript/5.1.6',
    ])

    first.registry.close()
    server.requests.splice(0)
    const second = open()
    const [again] = await plan(second, await findOutdated(second))
    expect(again.target).toBe('5.0.4')
    expect(manifestRequests()).toEqual([])
  })

  it('plans the engines hold at wanted for pnpm, which installs the highest version', async () => {
    const project = open('pnpm')
    const outdated = await findOutdated(project)

    const [result] = await plan(project, outdated)

    expect(result).toMatchObject({
      updated: false,
      reason: reasonFor('engines: needs node >=14.17 (running node 12.22.12)'),
    })
    expect(manifestRequests()).toEqual(['/typescript/5.1.6'])
  })

  it('discovery sends no manifest request, and wanted stays its own', async () => {
    const project = open()

    const outdated = await findOutdated(project)

    expect(outdated.typescript).toMatchObject({
      current: '5.0.2',
      wanted: '5.1.6',
    })
    expect(manifestRequests()).toEqual([])
  })
})
