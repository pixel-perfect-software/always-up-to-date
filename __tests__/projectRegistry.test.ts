jest.mock('@/utils/logger')

import fs from 'fs'
import path from 'path'
import { openProject, type Project } from '@/project'
import { registryFor } from '@/utils/registryRequest'
import { tempDir, write } from './fixtures/files'
import { startRegistry, type TestRegistry } from './fixtures/registry'

// The real project, session and adapter hook on temp directories: which files
// a run from a workspace member reads (pnpm 12.15.0 and bun 1.4.4, probed
// 2026-10-26).
describe('openProject registry config from a workspace member', () => {
  const A = 'http://127.0.0.1:4001/'
  const B = 'http://127.0.0.1:4002/'
  let tmp: string
  let home: string | undefined
  const projects: Project[] = []
  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const registryOf = (cwd: string, pm: 'pnpm' | 'bun') => {
    const project = openProject(cwd, { pm })
    projects.push(project)
    return project.registry.registryConfig()
  }

  beforeEach(() => {
    tmp = tempDir('autd-member-', { real: true })
    home = process.env.HOME
    process.env.HOME = at('home')
    write(at('package.json'), '{"name":"root","workspaces":["packages/*"]}')
    write(at('packages', 'app', 'package.json'), '{"name":"app"}')
  })
  afterEach(() => {
    for (const project of projects.splice(0)) project.registry.close()
    process.env.HOME = home
  })

  it('pnpm: uses the root pnpm-workspace.yaml and .npmrc, ignoring the member .npmrc', () => {
    write(
      at('pnpm-workspace.yaml'),
      `packages:\n  - packages/*\nregistries:\n  "@acme": ${B}\n`,
    )
    write(
      at('.npmrc'),
      `//127.0.0.1:4002/:_authToken=root\n@corp:registry=${A}\n`,
    )
    write(at('packages', 'app', '.npmrc'), `@corp:registry=${B}\n`)

    const config = registryOf(at('packages', 'app'), 'pnpm')

    expect(config.scopedRegistries).toEqual({ '@acme': B, '@corp': A })
    expect(config.credentials['//127.0.0.1:4002/']).toEqual({
      authToken: 'root',
    })
  })

  it('pnpm: a member with its own pnpm-workspace.yaml is its own root', () => {
    write(at('pnpm-workspace.yaml'), `registries:\n  "@acme": ${A}\n`)
    write(
      at('packages', 'app', 'pnpm-workspace.yaml'),
      `registries:\n  "@acme": ${B}\n`,
    )
    write(at('.npmrc'), '//127.0.0.1:4002/:_authToken=root\n')

    const config = registryOf(at('packages', 'app'), 'pnpm')

    expect(config.scopedRegistries).toEqual({ '@acme': B })
    expect(config.credentials).toEqual({})
  })

  it('bun: uses the root bunfig.toml and .npmrc, ignoring the member files', () => {
    write(at('bunfig.toml'), `[install.scopes]\nacme = "${B}"\n`)
    write(at('.npmrc'), '//127.0.0.1:4002/:_authToken=root\n')
    write(
      at('packages', 'app', 'bunfig.toml'),
      `[install.scopes]\nacme = "${A}"\n`,
    )
    write(
      at('packages', 'app', '.npmrc'),
      '//127.0.0.1:4002/:_authToken=member\n',
    )

    const config = registryOf(at('packages', 'app'), 'bun')

    expect(config.scopedRegistries).toEqual({ '@acme': B })
    expect(config.credentials['//127.0.0.1:4002/']).toEqual({
      authToken: 'root',
    })
  })
})

// #120: a yarn v1 project's .yarnrc routes reach the session's config
// (yarn 1.22.22, 2026-10-26).
describe('openProject registry config from a .yarnrc', () => {
  const A = 'http://127.0.0.1:4873/'
  const B = 'http://127.0.0.1:4874/'
  let tmp: string
  let home: string | undefined
  const projects: Project[] = []
  const registryOf = () => {
    const project = openProject(tmp)
    projects.push(project)
    return project.registry.registryConfig()
  }

  beforeEach(() => {
    tmp = tempDir('autd-yarnrc-', { real: true })
    home = process.env.HOME
    process.env.HOME = path.join(tmp, 'home')
    write(
      path.join(tmp, 'package.json'),
      '{"name":"p","dependencies":{"@acme/probe":"1.0.0","probe-unscoped":"1.0.0"}}',
    )
    write(path.join(tmp, 'yarn.lock'), '# yarn lockfile v1\n')
  })
  afterEach(() => {
    for (const project of projects.splice(0)) project.registry.close()
    process.env.HOME = home
  })

  it('routes the default registry and a scope from .yarnrc', () => {
    write(
      path.join(tmp, '.yarnrc'),
      `registry "${A}"\n"@acme:registry" "${B}"\n`,
    )
    const config = registryOf()
    expect(registryFor('probe-unscoped', config)).toBe(A)
    expect(registryFor('@acme/probe', config)).toBe(B)
  })

  it('ignores .yarnrc in a yarn berry project', () => {
    write(path.join(tmp, '.yarnrc'), `registry "${A}"\n`)
    write(path.join(tmp, '.yarnrc.yml'), 'nodeLinker: node-modules\n')
    expect(registryFor('probe-unscoped', registryOf())).toBe(
      'https://registry.yarnpkg.com',
    )
  })
})

// A yarn workspace member reads the project's .yarnrc routes when the project is
// v1 and none when it is berry (#123: berry/v1 was decided from the member's own
// package.json, so a berry member took v1's routes).
describe('openProject registry config from a yarn workspace member', () => {
  const A = 'http://127.0.0.1:4873/'
  let tmp: string
  let home: string | undefined
  const projects: Project[] = []
  const registryOfMember = () => {
    const project = openProject(path.join(tmp, 'packages', 'a'), { pm: 'yarn' })
    projects.push(project)
    return project.registry.registryConfig()
  }

  beforeEach(() => {
    tmp = tempDir('autd-yarn-member-', { real: true })
    home = process.env.HOME
    process.env.HOME = path.join(tmp, 'home')
    write(path.join(tmp, 'yarn.lock'), '')
    write(path.join(tmp, '.yarnrc'), `registry "${A}"\n`)
    write(path.join(tmp, 'packages', 'a', 'package.json'), '{"name":"a"}')
  })
  afterEach(() => {
    for (const project of projects.splice(0)) project.registry.close()
    process.env.HOME = home
  })

  it("a berry member ignores the root's .yarnrc", () => {
    write(
      path.join(tmp, 'package.json'),
      '{"name":"root","packageManager":"yarn@4.12.0","workspaces":["packages/*"]}',
    )

    expect(registryFor('ms', registryOfMember())).toBe(
      'https://registry.yarnpkg.com',
    )
  })

  // #127: a root install resolves a member's packages with the root's
  // settings, while yarn run from the member ranks `~/.npmrc` above the
  // root's `.npmrc` and reads the member's own (yarn 1.22.22, 2026-11-03,
  // m1, m2, m4). autd applies at the root, so a member run reads the root's.
  it("a v1 member reads the root's .npmrc over ~/.npmrc and its own", () => {
    const B = 'http://127.0.0.1:4874/'
    write(
      path.join(tmp, 'package.json'),
      '{"name":"root","packageManager":"yarn@1.22.22","workspaces":["packages/*"]}',
    )
    fs.rmSync(path.join(tmp, '.yarnrc'))
    write(path.join(tmp, '.npmrc'), `registry=${A}\n@acme:registry=${A}\n`)
    write(path.join(tmp, 'home', '.npmrc'), `registry=${B}\n`)
    write(path.join(tmp, 'packages', 'a', '.npmrc'), `@acme:registry=${B}\n`)

    const config = registryOfMember()
    expect(registryFor('ms', config)).toBe(A)
    expect(registryFor('@acme/probe', config)).toBe(A)
  })

  it("a v1 member reads the root's .yarnrc routes", () => {
    write(
      path.join(tmp, 'package.json'),
      '{"name":"root","packageManager":"yarn@1.22.22","workspaces":["packages/*"]}',
    )

    expect(registryFor('ms', registryOfMember())).toBe(A)
  })
})

// #126: a yarn v1 run sends credentials by yarn's rule, not npm's. yarn
// 1.22.22, probed 2026-11-03 against local registries logging Authorization:
// no token for an unscoped package (c01), the bare `_authToken` for a scoped
// one (c03), and a token for any package with always-auth (c02).
describe('openProject registry credentials for yarn v1', () => {
  let tmp: string
  let saved: { HOME?: string; PREFIX?: string }
  let server: TestRegistry
  const projects: Project[] = []
  const authorizationFor = async (
    pm: 'yarn' | 'npm',
    name: string,
  ): Promise<string | undefined> => {
    const project = openProject(tmp, { pm, cache: false })
    projects.push(project)
    const result = await project.registry.lookup(name)
    expect(result.ok).toBe(true)
    return server.requests.at(-1)?.headers.authorization
  }

  beforeEach(async () => {
    tmp = tempDir('autd-yarn-auth-', { real: true })
    saved = { HOME: process.env.HOME, PREFIX: process.env.PREFIX }
    process.env.HOME = path.join(tmp, 'home')
    process.env.PREFIX = path.join(tmp, 'prefix')
    write(path.join(tmp, 'package.json'), '{"name":"p"}')
    server = await startRegistry((req, res) => {
      const name = decodeURIComponent((req.url ?? '/').slice(1))
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          name,
          'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': { name, version: '1.0.0' } },
        }),
      )
    })
  })
  afterEach(async () => {
    for (const project of projects.splice(0)) project.registry.close()
    await server.close()
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  })

  it('sends no token for an unscoped package, where npm sends the host token', async () => {
    write(
      path.join(tmp, '.npmrc'),
      `registry=${server.url}\n//127.0.0.1:${server.port}/:_authToken=T\n`,
    )
    expect(await authorizationFor('yarn', 'probe-unscoped')).toBeUndefined()
    expect(await authorizationFor('npm', 'probe-unscoped')).toBe('Bearer T')
  })

  it('sends a token for an unscoped package with always-auth', async () => {
    write(
      path.join(tmp, '.npmrc'),
      `registry=${server.url}\n//127.0.0.1:${server.port}/:_authToken=T\nalways-auth=true\n`,
    )
    expect(await authorizationFor('yarn', 'probe-unscoped')).toBe('Bearer T')
  })

  it('sends the bare _authToken for a scoped package, which npm ignores', async () => {
    write(
      path.join(tmp, '.npmrc'),
      `_authToken=U\n@acme:registry=${server.url}\n`,
    )
    expect(await authorizationFor('yarn', '@acme/probe')).toBe('Bearer U')
    expect(await authorizationFor('npm', '@acme/probe')).toBeUndefined()
  })
})

// #107: a yarn berry run reads its registries and credentials from
// .yarnrc.yml, by berry's rule, and no .npmrc (yarn 4.18.1, probed
// 2026-11-03: r03, r10, r19). Before, berry kept npm's .npmrc view.
describe('openProject registry config for yarn berry', () => {
  let tmp: string
  let saved: string | undefined
  let server: TestRegistry
  const projects: Project[] = []
  const open = () => {
    const project = openProject(tmp, { pm: 'yarn', cache: false })
    projects.push(project)
    return project
  }

  beforeEach(async () => {
    tmp = tempDir('autd-berry-registry-', { real: true })
    saved = process.env.HOME
    process.env.HOME = path.join(tmp, 'home')
    write(
      path.join(tmp, 'package.json'),
      '{"name":"p","packageManager":"yarn@4.18.1"}',
    )
    write(path.join(tmp, 'yarn.lock'), '')
    server = await startRegistry((req, res) => {
      const name = decodeURIComponent((req.url ?? '/').slice(1))
      res.setHeader('content-type', 'application/json')
      res.end(
        JSON.stringify({
          name,
          'dist-tags': { latest: '1.0.0' },
          versions: { '1.0.0': { name, version: '1.0.0' } },
          // Past berry's default npmMinimalAgeGate (one day, #166).
          time: { '1.0.0': '2020-01-01T00:00:00.000Z' },
        }),
      )
    })
  })
  afterEach(async () => {
    for (const project of projects.splice(0)) project.registry.close()
    await server.close()
    if (saved === undefined) delete process.env.HOME
    else process.env.HOME = saved
  })

  it("routes a scope to its npmScopes registry and sends the scope's token", async () => {
    write(
      path.join(tmp, '.yarnrc.yml'),
      `unsafeHttpWhitelist: ["127.0.0.1"]\nnpmScopes:\n  acme:\n    npmRegistryServer: "${server.url}"\n    npmAuthToken: S\n`,
    )
    const result = await open().registry.lookup('@acme/probe')
    expect(result.ok).toBe(true)
    expect(server.requests.map((r) => r.headers.authorization)).toEqual([
      'Bearer S',
    ])
  })

  it('reads no .npmrc route or token', () => {
    write(
      path.join(tmp, '.npmrc'),
      `@acme:registry=${server.url}\n//127.0.0.1:${server.port}/:_authToken=N\nregistry=${server.url}\n`,
    )
    const config = open().registry.registryConfig()
    expect(registryFor('@acme/probe', config)).toBe(
      'https://registry.yarnpkg.com',
    )
    expect(registryFor('probe-unscoped', config)).toBe(
      'https://registry.yarnpkg.com',
    )
  })
})
