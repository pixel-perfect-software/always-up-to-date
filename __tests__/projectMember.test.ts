jest.mock('@/utils/logger')
jest.mock('@/utils/registry', () => ({
  createRegistrySession: jest.fn(() => ({ registryConfig: jest.fn() })),
}))

import fs from 'fs'
import os from 'os'
import path from 'path'
import pnpm from '@/managers/pnpm'
import { refuseMemberApply } from '@/pipeline'
import { openProject } from '@/project'
import { StepError } from '@/stepError'
import logger from '@/utils/logger'

// The real project location, detection and config on temp directories (#123).
describe('openProject from a workspace member', () => {
  let tmp: string
  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const workspace = (manager: Record<string, unknown> = {}) => {
    write(
      at('package.json'),
      JSON.stringify({
        name: 'ws-root',
        workspaces: ['packages/*'],
        ...manager,
      }),
    )
    write(at('packages', 'a', 'package.json'), '{"name":"@ws/a"}')
  }

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'autd-member-')),
    )
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('gives the root and the member', () => {
    workspace({ packageManager: 'npm@11.19.1' })

    const project = openProject(at('packages', 'a'))

    expect(project.root).toBe(tmp)
    expect(project.member).toEqual({ path: 'packages/a', name: '@ws/a' })
    expect(project.adapter.name).toBe('npm')
  })

  it('gives the same from a directory inside the member', () => {
    workspace({ packageManager: 'npm@11.19.1' })
    fs.mkdirSync(at('packages', 'a', 'src'))

    const project = openProject(at('packages', 'a', 'src'))

    expect(project.root).toBe(tmp)
    expect(project.member).toEqual({ path: 'packages/a', name: '@ws/a' })
  })

  it('has no member for a run from the root', () => {
    workspace({ packageManager: 'npm@11.19.1' })

    const project = openProject(tmp)

    expect(project.root).toBe(tmp)
    expect(project.member).toBeUndefined()
  })

  it("reads the member's own config over the root's, and logs the choice", () => {
    workspace({ packageManager: 'npm@11.19.1' })
    write(at('.always-up-to-date.json'), '{"silent":true}')
    write(at('packages', 'a', '.always-up-to-date.json'), '{"debug":true}')

    const project = openProject(at('packages', 'a'))

    expect(project.config).toMatchObject({ debug: true, silent: false })
    expect(logger.debug).toHaveBeenCalledWith(
      `config: ${at('packages', 'a', '.always-up-to-date.json')}; root ${tmp}; member packages/a`,
    )
  })

  it("reads the root's config when the member has none", () => {
    workspace({ packageManager: 'npm@11.19.1' })
    write(at('.always-up-to-date.json'), '{"silent":true}')

    expect(openProject(at('packages', 'a')).config.silent).toBe(true)
  })

  it('fails in detect for a berry directory the root does not list', () => {
    workspace({ packageManager: 'yarn@4.12.0' })
    write(at('yarn.lock'), '')
    write(at('tools', 'x', 'package.json'), '{"name":"x"}')

    let thrown: unknown
    try {
      openProject(at('tools', 'x'), { pm: 'yarn' })
    } catch (error) {
      thrown = error
    }

    expect(thrown).toBeInstanceOf(StepError)
    expect((thrown as StepError).step).toBe('detect')
    expect((thrown as StepError).message).toContain(
      'not listed in "workspaces"',
    )
  })

  it('refuses update from a member, from the root it names', () => {
    workspace({ packageManager: 'npm@11.19.1' })

    expect(() => refuseMemberApply(openProject(at('packages', 'a')))).toThrow(
      expect.objectContaining({
        step: 'apply',
        message: expect.stringContaining(`run autd update in ${tmp}`),
      }),
    )
    expect(() => refuseMemberApply(openProject(tmp))).not.toThrow()
  })

  it('is its own project for an unlisted directory with --pm npm', () => {
    workspace({ packageManager: 'npm@11.19.1' })
    write(at('tools', 'x', 'package.json'), '{"name":"x"}')

    const project = openProject(at('tools', 'x'), { pm: 'npm' })

    expect(project.root).toBe(at('tools', 'x'))
    expect(project.member).toBeUndefined()
    expect(() => refuseMemberApply(project)).not.toThrow()
  })

  it('makes a pnpm member with its own pnpm-workspace.yaml its own root', () => {
    write(
      at('package.json'),
      '{"name":"ws-root","packageManager":"pnpm@12.14.0"}',
    )
    write(at('pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    // Its own project, so its own manager declaration.
    write(
      at('packages', 'a', 'package.json'),
      '{"name":"@ws/a","packageManager":"pnpm@12.14.0"}',
    )
    write(at('packages', 'a', 'pnpm-workspace.yaml'), 'packages: []\n')

    const project = openProject(at('packages', 'a'))

    expect(project.adapter).toBe(pnpm)
    expect(project.root).toBe(at('packages', 'a'))
    expect(project.member).toBeUndefined()
  })

  it('makes a pnpm member listed by the root yaml a member', () => {
    write(
      at('package.json'),
      '{"name":"ws-root","packageManager":"pnpm@12.14.0"}',
    )
    write(at('pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    write(at('packages', 'a', 'package.json'), '{"name":"@ws/a"}')

    const project = openProject(at('packages', 'a'))

    expect(project.root).toBe(tmp)
    expect(project.member?.path).toBe('packages/a')
  })

  it("reads the npm root's config for a member that carries a stray settings-only pnpm-workspace.yaml", () => {
    // `locate` takes the member's own yaml for a root of its own; npm's
    // project is the root that lists it, so the config is the root's.
    workspace({ packageManager: 'npm@11.19.1' })
    write(at('.always-up-to-date.json'), '{"beyondRange":"minor"}')
    write(at('packages', 'a', 'pnpm-workspace.yaml'), 'catalog:\n  ms: ^2\n')

    const project = openProject(at('packages', 'a'), { pm: 'npm' })

    expect(project.root).toBe(tmp)
    expect(project.member?.path).toBe('packages/a')
    expect(project.config.beyondRange).toBe('minor')
  })

  it('reads the config of the pnpm project that a nearer settings-only yaml makes of a member', () => {
    // R lists apps/**, but pnpm reads only R/apps's yaml, which lists nothing.
    write(
      at('package.json'),
      '{"name":"ws-root","packageManager":"pnpm@12.14.0"}',
    )
    write(at('pnpm-workspace.yaml'), 'packages:\n  - apps/**\n')
    write(at('.always-up-to-date.json'), '{"beyondRange":"minor"}')
    write(at('apps', 'pnpm-workspace.yaml'), 'catalog:\n  ms: ^2\n')
    write(
      at('apps', 'web', 'package.json'),
      '{"name":"web","packageManager":"pnpm@12.14.0"}',
    )

    const project = openProject(at('apps', 'web'))

    expect(project.root).toBe(at('apps', 'web'))
    expect(project.member).toBeUndefined()
    expect(project.config.beyondRange).toBeUndefined()
  })
})
