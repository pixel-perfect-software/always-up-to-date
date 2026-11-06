import fs from 'fs'
import os from 'os'
import path from 'path'
import {
  coldCaches,
  jsonPathFrom,
  managerOf,
  runsFrom,
  selectedTargets,
  startupMode,
  TARGETS,
} from '../../bench/targets'

describe('selectedTargets', () => {
  it('runs every target when unset or blank', () => {
    expect(selectedTargets(undefined)).toEqual([...TARGETS])
    expect(selectedTargets('  ')).toEqual([...TARGETS])
  })

  it('takes a comma-separated selection, berry rows included', () => {
    expect(selectedTargets('npm, berry,berry-nm')).toEqual([
      'npm',
      'berry',
      'berry-nm',
    ])
  })

  it('fails fast on the empty name a trailing comma leaves', () => {
    expect(() => selectedTargets('npm,')).toThrow(/unknown manager \(empty\)/)
  })

  it('fails fast on an unknown name', () => {
    expect(() => selectedTargets('npm,deno')).toThrow(
      'AUTD_BENCH_PM: unknown manager deno; use npm, pnpm, yarn, berry, berry-nm, bun',
    )
  })
})

describe('runsFrom', () => {
  it('keeps the fallback unless set', () => {
    expect(runsFrom(undefined, 5)).toBe(5)
    expect(runsFrom('', 5)).toBe(5)
    expect(runsFrom('2', 5)).toBe(2)
  })

  it.each(['0', '-1', '1.5', 'many'])('rejects %j', (value) => {
    expect(() => runsFrom(value, 5)).toThrow(/AUTD_BENCH_RUNS/)
  })
})

describe('coldCaches', () => {
  const root = path.join(path.sep, 'c')
  const at = (name: string): string => path.join(root, name)

  it('gives every target a cache folder of its own under the root', () => {
    const dirs = TARGETS.map((target) => coldCaches(target, root).dirs[0])

    expect(new Set(dirs).size).toBe(TARGETS.length)
    for (const dir of dirs) expect(dir.startsWith(root)).toBe(true)
  })

  it('points each manager at the folder it empties', () => {
    expect(coldCaches('npm', root)).toEqual({
      env: { npm_config_cache: at('npm'), AUTD_CACHE_DIR: at('npm-autd') },
      dirs: [at('npm'), at('npm-autd')],
    })
    expect(coldCaches('pnpm', root).env).toMatchObject({
      npm_config_cache_dir: at('pnpm'),
      pnpm_config_cache_dir: at('pnpm'),
    })
    expect(coldCaches('yarn', root).env).toMatchObject({
      YARN_CACHE_FOLDER: at('yarn'),
    })
    expect(coldCaches('berry-nm', root).env).toMatchObject({
      YARN_GLOBAL_FOLDER: at('berry-nm'),
    })
    expect(coldCaches('bun', root).env).toMatchObject({
      BUN_INSTALL_CACHE_DIR: at('bun'),
    })
  })

  it("empties autd's own cache, in a folder per target under the root", () => {
    const folders = TARGETS.map((target) => {
      const { env, dirs } = coldCaches(target, root)
      expect(dirs).toContain(env.AUTD_CACHE_DIR)
      expect(env.AUTD_CACHE_DIR?.startsWith(root)).toBe(true)
      return env.AUTD_CACHE_DIR
    })

    expect(new Set(folders).size).toBe(TARGETS.length)
  })
})

describe('managerOf', () => {
  it('runs both berry rows on berry', () => {
    expect(managerOf('berry')).toBe('berry')
    expect(managerOf('berry-nm')).toBe('berry')
    expect(managerOf('bun')).toBe('bun')
  })
})

describe('startupMode', () => {
  it('times startup with the managers unless told otherwise', () => {
    expect(startupMode(undefined)).toBe('include')
    expect(startupMode('')).toBe('include')
    expect(startupMode('  ')).toBe('include')
  })

  it('takes only and skip', () => {
    expect(startupMode('only')).toBe('only')
    expect(startupMode(' skip ')).toBe('skip')
  })

  it.each(['both', 'ONLY', 'true', '0'])('rejects %j', (value) => {
    expect(() => startupMode(value)).toThrow(
      `AUTD_BENCH_STARTUP: unknown mode ${value}; use only, skip`,
    )
  })
})

describe('jsonPathFrom', () => {
  let dir: string

  beforeEach(() => {
    dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'autd-json-')))
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('writes no document when unset or blank', () => {
    expect(jsonPathFrom(undefined, dir)).toBeUndefined()
    expect(jsonPathFrom(' ', dir)).toBeUndefined()
  })

  it('resolves a relative path against the working directory', () => {
    expect(jsonPathFrom('out.json', dir)).toBe(path.join(dir, 'out.json'))
    expect(jsonPathFrom(path.join(dir, 'a.json'), os.tmpdir())).toBe(
      path.join(dir, 'a.json'),
    )
  })

  it('fails before the run when the folder is missing or the path is a folder', () => {
    expect(() => jsonPathFrom(path.join('missing', 'out.json'), dir)).toThrow(
      /AUTD_BENCH_JSON: the folder of .* does not exist/,
    )
    expect(() => jsonPathFrom(dir, os.tmpdir())).toThrow(
      /AUTD_BENCH_JSON: .* is a folder/,
    )
  })
})
