import fs from 'fs'
import os from 'os'
import path from 'path'
import { locate } from '@/projectLocation'

// Real temp directories: where a run belongs before a manager is known (#123).
describe('locate', () => {
  let tmp: string
  const at = (...parts: string[]) => path.join(tmp, ...parts)
  const write = (file: string, content: string) => {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content)
  }
  const manifest = (dir: string[], fields: Record<string, unknown> = {}) =>
    write(at(...dir, 'package.json'), JSON.stringify({ name: 'p', ...fields }))

  beforeEach(() => {
    tmp = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'autd-locate-')),
    )
  })
  afterEach(() => {
    fs.rmSync(tmp, { recursive: true, force: true })
  })

  it('is the root itself for a run from the root', () => {
    manifest([], { workspaces: ['packages/*'] })
    manifest(['packages', 'a'])

    expect(locate(tmp)).toEqual({ dir: tmp, workspaceRoot: tmp })
  })

  it.each([
    ['an array', ['packages/*']],
    ['an object with packages', { packages: ['packages/*'] }],
  ])('finds the root that lists a member in %s', (_, workspaces) => {
    manifest([], { workspaces })
    manifest(['packages', 'a'])

    expect(locate(at('packages', 'a'))).toEqual({
      dir: at('packages', 'a'),
      workspaceRoot: tmp,
    })
  })

  it("finds the root that lists a member in pnpm-workspace.yaml's packages", () => {
    manifest([])
    write(at('pnpm-workspace.yaml'), 'packages:\n  - packages/*\n')
    manifest(['packages', 'a'])

    expect(locate(at('packages', 'a'))).toEqual({
      dir: at('packages', 'a'),
      workspaceRoot: tmp,
    })
  })

  it('treats a directory inside a member as the member', () => {
    manifest([], { workspaces: ['packages/*'] })
    manifest(['packages', 'a'])
    fs.mkdirSync(at('packages', 'a', 'src'), { recursive: true })

    expect(locate(at('packages', 'a', 'src'))).toEqual({
      dir: at('packages', 'a'),
      workspaceRoot: tmp,
    })
  })

  it('is its own root when no ancestor lists it', () => {
    manifest([], { workspaces: ['packages/*'] })
    manifest(['tools', 'x'])

    expect(locate(at('tools', 'x'))).toEqual({
      dir: at('tools', 'x'),
      workspaceRoot: at('tools', 'x'),
    })
  })

  it('is its own root when a negated pattern excludes it', () => {
    manifest([], { workspaces: ['packages/*', '!packages/a'] })
    manifest(['packages', 'a'])
    manifest(['packages', 'b'])

    expect(locate(at('packages', 'a')).workspaceRoot).toBe(at('packages', 'a'))
    expect(locate(at('packages', 'b')).workspaceRoot).toBe(tmp)
  })

  it('is its own root when it has a pnpm-workspace.yaml of its own', () => {
    manifest([], { workspaces: ['packages/*'] })
    manifest(['packages', 'a'])
    write(at('packages', 'a', 'pnpm-workspace.yaml'), 'catalog:\n  ms: ^2\n')

    expect(locate(at('packages', 'a'))).toEqual({
      dir: at('packages', 'a'),
      workspaceRoot: at('packages', 'a'),
    })
  })

  it('is the nearest ancestor that lists it when several do', () => {
    manifest([], { workspaces: ['outer/**'] })
    manifest(['outer', 'mid'], { workspaces: ['inner'] })
    manifest(['outer', 'mid', 'inner'])

    expect(locate(at('outer', 'mid', 'inner')).workspaceRoot).toBe(
      at('outer', 'mid'),
    )
  })

  it('is the cwd when no package.json exists anywhere above it', () => {
    fs.mkdirSync(at('empty', 'deep'), { recursive: true })

    expect(locate(at('empty', 'deep'))).toEqual({
      dir: at('empty', 'deep'),
      workspaceRoot: at('empty', 'deep'),
    })
  })
})
