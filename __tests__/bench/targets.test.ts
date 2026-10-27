import path from 'path'
import {
  coldCaches,
  managerOf,
  runsFrom,
  selectedTargets,
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
