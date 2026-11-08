import { adapterFor, adapters, supportedManagers } from '@/managers'

describe('adapter registry', () => {
  it.each(['npm', 'yarn', 'pnpm', 'bun'] as const)(
    'returns the %s adapter by name',
    (name) => {
      expect(adapterFor(name).name).toBe(name)
    },
  )

  it('gives each manager its own lockfile', () => {
    const lockfiles = Object.values(adapters).map((adapter) => adapter.lockfile)
    expect(new Set(lockfiles).size).toBe(lockfiles.length)
  })

  it('marks npm as the one manager that skips an engines-excluded version (#200)', () => {
    expect(
      Object.entries(adapters)
        .filter(([, adapter]) => adapter.skipsEnginesExcluded?.('.'))
        .map(([name]) => name),
    ).toEqual(['npm'])
  })

  it('lists the manager names in registry order, which the --pm message shows', () => {
    expect(supportedManagers).toEqual(Object.keys(adapters))
  })
})
