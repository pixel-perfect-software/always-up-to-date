import fs from 'fs'
import os from 'os'
import path from 'path'
import { adapterFor } from '@/managers'
import { isolateNpmConfig } from '../fixtures'

// Each case mirrors a real `add` on the manager's current version, which
// wrote the spec shown in the comment.
describe('adapter.saveStyle', () => {
  let cwd: string

  const write = (file: string, content: string) =>
    fs.writeFileSync(path.join(cwd, file), content)

  let home: string
  let restoreNpmConfig: () => void

  beforeEach(() => {
    cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-save-style-'))
    // Keep the developer's own ~/.npmrc out of these cases.
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'autd-home-'))
    restoreNpmConfig = isolateNpmConfig(home)
    write('package.json', '{}')
  })

  afterEach(() => {
    restoreNpmConfig()
    fs.rmSync(cwd, { recursive: true, force: true })
    fs.rmSync(home, { recursive: true, force: true })
  })

  it('defaults to a caret for every manager', () => {
    for (const pm of ['npm', 'pnpm', 'yarn', 'bun'] as const) {
      expect(adapterFor(pm).saveStyle(cwd)).toEqual({
        exact: false,
        prefix: '^',
      })
    }
  })

  it('npm: save-prefix and save-exact from .npmrc', () => {
    write('.npmrc', 'save-prefix=~\n') // npm install ms → "~2.1.3"
    expect(adapterFor('npm').saveStyle(cwd)).toEqual({
      exact: false,
      prefix: '~',
    })

    write('.npmrc', 'save-exact=true\n') // npm install ms → "2.1.3"
    expect(adapterFor('npm').saveStyle(cwd).exact).toBe(true)
  })

  it('pnpm: savePrefix and saveExact from pnpm-workspace.yaml, not .npmrc', () => {
    write('.npmrc', 'save-prefix=~\n') // ignored by pnpm 12: "^2.1.3"
    expect(adapterFor('pnpm').saveStyle(cwd)).toEqual({
      exact: false,
      prefix: '^',
    })

    write('pnpm-workspace.yaml', "savePrefix: '~'\n") // "~2.1.3"
    expect(adapterFor('pnpm').saveStyle(cwd)).toEqual({
      exact: false,
      prefix: '~',
    })

    write('pnpm-workspace.yaml', 'saveExact: true\n') // "2.1.3"
    expect(adapterFor('pnpm').saveStyle(cwd).exact).toBe(true)
  })

  it('yarn berry: defaultSemverRangePrefix from .yarnrc.yml, empty meaning exact', () => {
    write('package.json', '{"packageManager":"yarn@4.18.1"}')

    write('.yarnrc.yml', "defaultSemverRangePrefix: '~'\n") // "~2.1.3"
    expect(adapterFor('yarn').saveStyle(cwd)).toEqual({
      exact: false,
      prefix: '~',
    })

    write('.yarnrc.yml', "defaultSemverRangePrefix: ''\n") // "2.1.3"
    expect(adapterFor('yarn').saveStyle(cwd).exact).toBe(true)
  })

  it('bun: exact from bunfig.toml [install] or .npmrc save-exact; no prefix setting', () => {
    write('bunfig.toml', '[install]\nexact = true\n') // "2.1.3"
    expect(adapterFor('bun').saveStyle(cwd).exact).toBe(true)

    write('bunfig.toml', '[install]\nexact = false\n[run]\nexact = true\n')
    expect(adapterFor('bun').saveStyle(cwd).exact).toBe(false)

    write('.npmrc', 'save-exact=true\n') // "2.1.3"
    expect(adapterFor('bun').saveStyle(cwd).exact).toBe(true)
  })
})
