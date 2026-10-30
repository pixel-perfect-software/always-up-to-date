jest.mock('@/utils/logger')

import fs from 'fs'
import os from 'os'
import path from 'path'
import { openProject, type Project } from '@/project'
import { registryFor } from '@/utils/registryRequest'

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
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const registryOf = (cwd: string, pm: 'pnpm' | 'bun') => {
    const project = openProject(cwd, { pm })
    projects.push(project)
    return project.registry.registryConfig()
  }

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'autd-member-')),
    )
    home = process.env.HOME
    process.env.HOME = at('home')
    write(at('package.json'), '{"name":"root","workspaces":["packages/*"]}')
    write(at('packages', 'app', 'package.json'), '{"name":"app"}')
  })
  afterEach(() => {
    for (const project of projects.splice(0)) project.registry.close()
    process.env.HOME = home
    fs.rmSync(tmp, { recursive: true, force: true })
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
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const registryOf = () => {
    const project = openProject(tmp)
    projects.push(project)
    return project.registry.registryConfig()
  }

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'autd-yarnrc-')),
    )
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
    fs.rmSync(tmp, { recursive: true, force: true })
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
      'https://registry.npmjs.org/',
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
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const registryOfMember = () => {
    const project = openProject(path.join(tmp, 'packages', 'a'), { pm: 'yarn' })
    projects.push(project)
    return project.registry.registryConfig()
  }

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'autd-yarn-member-')),
    )
    home = process.env.HOME
    process.env.HOME = path.join(tmp, 'home')
    write(path.join(tmp, 'yarn.lock'), '')
    write(path.join(tmp, '.yarnrc'), `registry "${A}"\n`)
    write(path.join(tmp, 'packages', 'a', 'package.json'), '{"name":"a"}')
  })
  afterEach(() => {
    for (const project of projects.splice(0)) project.registry.close()
    process.env.HOME = home
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it("a berry member ignores the root's .yarnrc", () => {
    write(
      path.join(tmp, 'package.json'),
      '{"name":"root","packageManager":"yarn@4.12.0","workspaces":["packages/*"]}',
    )

    expect(registryFor('ms', registryOfMember())).toBe(
      'https://registry.npmjs.org/',
    )
  })

  it("a v1 member reads the root's .yarnrc routes", () => {
    write(
      path.join(tmp, 'package.json'),
      '{"name":"root","packageManager":"yarn@1.22.22","workspaces":["packages/*"]}',
    )

    expect(registryFor('ms', registryOfMember())).toBe(A)
  })
})
