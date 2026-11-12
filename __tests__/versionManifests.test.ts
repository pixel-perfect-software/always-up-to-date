jest.mock('@/utils/logger')

import fs from 'fs'
import path from 'path'
import { check, findOutdated, plan } from '@/pipeline'
import { openProject, type Project } from '@/project'
import { isolateNpmConfig } from './fixtures'
import { tempDir, write } from './fixtures/files'
import {
  derive,
  type Reply,
  registryBody,
  replies,
  startRegistry,
  type TestRegistry,
} from './fixtures/registry'

// #196: the plan reads each moving target's own manifest, through the real
// session, reader and disk cache, from a local registry serving the captures
// of `__tests__/fixtures/registry/`. Nothing holds on them yet; these pin
// which requests go out.

const packument = (name: string): Reply => ({
  body: registryBody(name),
  type: 'application/vnd.npm.install-v1+json',
})
const manifest = (name: string): Reply => ({ body: registryBody(name) })

/** A request for one version's manifest: `/<name>/<version>`, a scope's slash escaped. */
const isManifestUrl = (url: string): boolean =>
  /^\/(@[^/]+%2f)?[^/]+\/[^/]+$/.test(url)

let tmp: string
const at = (...parts: string[]) => path.join(tmp, ...parts)

/** A captured manifest with its version replaced, as `node_modules/<name>/package.json`. */
const installAt = (name: string, capture: string, version: string) =>
  write(
    at('node_modules', name, 'package.json'),
    derive(capture, (body: { version: string }) => {
      body.version = version
    }),
  )

describe('version manifests in the plan (#196)', () => {
  let server: TestRegistry
  let saved: NodeJS.ProcessEnv
  let restoreNpm: () => void
  const projects: Project[] = []

  beforeEach(async () => {
    tmp = tempDir('autd-manifests-', { real: true })
    saved = { ...process.env }
    restoreNpm = isolateNpmConfig(at('npm-config'))
    process.env.XDG_CONFIG_HOME = at('xdg')
    // The cache is on, in a folder of the test's own.
    delete process.env.AUTD_NO_CACHE
    process.env.AUTD_CACHE_DIR = at('cache')
    server = await startRegistry(
      replies({
        '/ms': packument('ms.packument'),
        '/@types%2fms': packument('types-ms.packument'),
        '/ms/2.1.3': manifest('ms.2.1.3.manifest'),
        '/@types%2fms/2.1.0': manifest('types-ms.2.1.0.manifest'),
      }),
    )
    write(at('.npmrc'), `registry=${server.url}\n`)
    // Exact pins, held by the default policy and moved by beyondRange.
    write(
      at('package.json'),
      JSON.stringify({
        name: 'p',
        dependencies: { ms: '2.1.2', '@types/ms': '0.7.34' },
      }),
    )
    // The installed copies are the captured manifests at the declared pins,
    // so their licenses are real (installPackages would read as none, #197).
    installAt('ms', 'ms.2.1.3.manifest', '2.1.2')
    installAt('@types/ms', 'types-ms.2.1.0.manifest', '0.7.34')
  })
  afterEach(async () => {
    for (const project of projects.splice(0)) project.registry.close()
    await server.close()
    restoreNpm()
    for (const key of Object.keys(process.env)) delete process.env[key]
    Object.assign(process.env, saved)
  })

  const open = (config: Record<string, unknown> = {}) => {
    write(at('.always-up-to-date.json'), JSON.stringify(config))
    const project = openProject(tmp, { pm: 'npm' })
    projects.push(project)
    return project
  }
  const manifestRequests = () =>
    server.requests.map((r) => r.url).filter(isManifestUrl)

  it('sends none for discovery alone, which never plans', async () => {
    const project = open({ beyondRange: 'major' })

    const outdated = await findOutdated(project)

    expect(Object.keys(outdated).sort()).toEqual(['@types/ms', 'ms'])
    expect(manifestRequests()).toEqual([])
  })

  it('sends none for a check whose every row is held', async () => {
    const project = open()

    await check(project)

    expect(server.requests.length).toBeGreaterThan(0)
    expect(manifestRequests()).toEqual([])
  })

  it('sends one per moving target, none for a second plan, and none from a new session on the same cache', async () => {
    const first = open({ beyondRange: 'major' })
    const outdated = await findOutdated(first)

    const results = await plan(first, outdated)
    expect(
      results.filter((r) => r.updated).map((r) => [r.name, r.target]),
    ).toEqual([
      ['@types/ms', '2.1.0'],
      ['ms', '2.1.3'],
    ])
    await plan(first, outdated)
    expect(manifestRequests().sort()).toEqual([
      '/@types%2fms/2.1.0',
      '/ms/2.1.3',
    ])
    first.registry.close()
    server.requests.splice(0)

    const second = open({ beyondRange: 'major' })
    await plan(second, await findOutdated(second))
    expect(manifestRequests()).toEqual([])
    expect(
      fs.readdirSync(path.join(at('cache'), 'v1', 'manifest')),
    ).toHaveLength(2)
  })

  it("reads the current version's manifest once when nothing is installed (#197)", async () => {
    fs.rmSync(at('node_modules'), { recursive: true })
    write(
      at('package.json'),
      JSON.stringify({ name: 'project', dependencies: { ms: '2.1.1' } }),
    )
    fs.copyFileSync(
      path.join(__dirname, 'fixtures/npm/no-node-modules.package-lock.json'),
      at('package-lock.json'),
    )
    await server.close()
    server = await startRegistry(
      replies({
        '/ms': packument('ms.packument'),
        '/ms/2.1.3': manifest('ms.2.1.3.manifest'),
        '/ms/2.1.1': manifest('ms.2.1.1.manifest'),
      }),
    )
    write(at('.npmrc'), `registry=${server.url}\n`)
    const first = open({ beyondRange: 'major' })
    const outdated = await findOutdated(first)

    const results = await plan(first, outdated)
    await plan(first, outdated)

    expect(results).toEqual([
      expect.objectContaining({ name: 'ms', target: '2.1.3', updated: true }),
    ])
    expect(manifestRequests().sort()).toEqual(['/ms/2.1.1', '/ms/2.1.3'])
    first.registry.close()
    server.requests.splice(0)

    const second = open({ beyondRange: 'major' })
    await plan(second, await findOutdated(second))
    expect(manifestRequests()).toEqual([])
  })

  it("sends a scoped package's request with npm's credentials for its registry", async () => {
    write(
      at('.npmrc'),
      `registry=${server.url}\n//127.0.0.1:${server.port}/:_authToken=TOK\n`,
    )
    const project = open({ beyondRange: 'major' })

    await plan(project, await findOutdated(project))

    const sent = server.requests.find((r) => r.url === '/@types%2fms/2.1.0')
    expect(sent?.headers.authorization).toBe('Bearer TOK')
  })
})
